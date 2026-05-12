"""
tune.py — Optuna hyperparameter search for EmotionTransformer (Phase A + Phase B).

Objective: run Phase A on clean paired data as curriculum initialisation, then
continue with Phase B on the full dataset (all modalities, mixup enabled).

Composite objective (val only — test is NEVER optimised on):
    0.30 * val_acc              overall accuracy on full val split
    0.30 * macro_f1             class-balanced F1 (protects fearful/disgust minorities)
    0.10 * macro_recall         explicit minority-class recall (fearful/sad/neutral)
    0.15 * ravdess_acc          per-dataset robustness
    0.15 * crema_acc            per-dataset robustness
  - 0.05 * min(σ_tail, 0.03)   instability penalty (capped to prevent over-punishment)
  - 0.10 * ece                  Expected Calibration Error (production confidence quality)

Test accuracy is logged as a user_attr every TEST_EVAL_INTERVAL trials and for
the final top-K summary, but NEVER enters the return value — the test split stays
a true held-out benchmark across the entire study.

Phase A tunes: class_boost, separation margins/weights, lr_a, dropout, label_smoothing.
Phase B adds:  lr_b, ravdess_weight_b, swa_tail, mixup_alpha, mixup_prob.

Usage:
    python training/tune.py                  # 30 trials, fresh study
    python training/tune.py --trials 60      # custom trial count
    python training/tune.py --resume         # continue existing study
    python training/tune.py --resume --trials 20
    python training/tune.py --timeout 7200   # run for 2 hours max
"""

import argparse
import copy
import gc
import json
import logging
import random
import sys
from pathlib import Path

import numpy as np
import optuna
import torch
from torch.optim import AdamW

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR / "training"))

from train_modal import (
    build_train_config,
    EmotionTransformer,
    FocalLoss,
    SWAHandler,
    WarmupCosineScheduler,
    filter_both_modalities,
    compute_class_weights,
    make_loader,
    run_epoch,
    evaluate,
)

optuna.logging.set_verbosity(optuna.logging.WARNING)

STUDY_DB = str(BASE_DIR / "logs" / "optuna_study_ab_v3.db")
STUDY_NAME = "emotion_phaseAB_v3"

TRIAL_EPOCHS_A = 9
TRIAL_EPOCHS_B = 20
WARMUP_EPOCHS = 2

_TRIAL_PATIENCE_A = 4
_TRIAL_PATIENCE_B = 6

_SWA_TAIL_MIN = 2
_SWA_TAIL_MAX = 7

_SWA_MIN_EPOCHS_SURVIVED = 12

TEST_EVAL_INTERVAL = 5
TEST_EVAL_TOP_K = 5

_ECE_BINS = 10

_GLOBAL_SEED = 42


def set_seed(seed: int = _GLOBAL_SEED) -> None:
    """Seed all relevant random number generators for reproducibility.

    Args:
        seed: Integer seed value applied to Python ``random``, NumPy, and all
            available PyTorch backends (CPU, CUDA, MPS).
    """
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.backends.mps.is_available():
        torch.mps.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_data(cfg_raw):
    """Load and partition the dataset for Phase A and Phase B training.

    Reads the pre-normalised ``.npz`` archive produced by
    ``extract_embeddings_data.py``.  No additional z-score normalisation is
    applied here.  Schema assertions guard against silent dimension mismatches
    between the config and the stored arrays.

    Args:
        cfg_raw: Raw config dict loaded from ``config/config.json``.

    Returns:
        A 2-tuple ``(cfg, data)`` where *cfg* is the constructed
        :class:`TrainConfig` and *data* is a dict with keys:

        - ``"train_A"`` / ``"val_A"``: both-modality samples only (Phase A).
        - ``"train_B"`` / ``"val_B"``: all modalities (Phase B).
        - ``"test"``: held-out test split (logged only, never optimised on).

        Each value is a tuple ``(Xf, Xa, fm, am, y, act)``.
    """
    cfg = build_train_config(cfg_raw)
    data = np.load(BASE_DIR / cfg.data_path)

    proc = cfg_raw["processing"]
    assert (
        data["X_audio_train"].shape[-1] == proc["audio_dim"]
    ), f"audio_dim mismatch: got {data['X_audio_train'].shape[-1]}, expected {proc['audio_dim']}"
    assert (
        data["X_face_train"].shape[-1] == proc["face_dim"]
    ), f"face_dim mismatch: got {data['X_face_train'].shape[-1]}, expected {proc['face_dim']}"
    assert (
        data["X_audio_train"].shape[1] == proc["seq_len"]
    ), f"audio seq_len mismatch: got {data['X_audio_train'].shape[1]}, expected {proc['seq_len']}"
    assert (
        data["X_face_train"].shape[1] == proc["seq_len"]
    ), f"face seq_len mismatch: got {data['X_face_train'].shape[1]}, expected {proc['seq_len']}"

    Xf_tr = data["X_face_train"]
    Xa_tr = data["X_audio_train"]
    fm_tr = data["face_mask_train"]
    am_tr = data["audio_mask_train"]
    y_tr = data["y_train"]
    act_tr = data["actor_train"]
    mod_tr = data["modality_train"]

    Xf_va = data["X_face_val"]
    Xa_va = data["X_audio_val"]
    fm_va = data["face_mask_val"]
    am_va = data["audio_mask_val"]
    y_va = data["y_val"]
    act_va = data["actor_val"]
    mod_va = data["modality_val"]

    Xf_te = data["X_face_test"]
    Xa_te = data["X_audio_test"]
    fm_te = data["face_mask_test"]
    am_te = data["audio_mask_test"]
    y_te = data["y_test"]
    act_te = data["actor_test"]

    Xf_tr_A, Xa_tr_A, fm_tr_A, am_tr_A, y_tr_A, act_tr_A, _ = filter_both_modalities(
        Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, act_tr, mod_tr
    )
    Xf_va_A, Xa_va_A, fm_va_A, am_va_A, y_va_A, act_va_A, _ = filter_both_modalities(
        Xf_va, Xa_va, fm_va, am_va, y_va, act_va, mod_va
    )

    return cfg, {
        "train_A": (Xf_tr_A, Xa_tr_A, fm_tr_A, am_tr_A, y_tr_A, act_tr_A),
        "val_A": (Xf_va_A, Xa_va_A, fm_va_A, am_va_A, y_va_A, act_va_A),
        "train_B": (Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, act_tr),
        "val_B": (Xf_va, Xa_va, fm_va, am_va, y_va, act_va),
        "test": (Xf_te, Xa_te, fm_te, am_te, y_te, act_te),
    }


def _make_loader(arrays, cfg, augment, use_sampler, ravdess_weight=1.2):
    """Construct a :class:`~torch.utils.data.DataLoader` from a raw array tuple.

    Args:
        arrays: Tuple ``(Xf, Xa, fm, am, y, act)`` of pre-split arrays.
        cfg: :class:`TrainConfig` instance carrying batch size and worker settings.
        augment: Whether to apply on-the-fly data augmentation.
        use_sampler: Whether to use a ``WeightedRandomSampler`` for class balance.
        ravdess_weight: Sampling weight multiplier applied to RAVDESS samples.

    Returns:
        A configured :class:`~torch.utils.data.DataLoader`.
    """
    Xf, Xa, fm, am, y, act = arrays
    return make_loader(
        Xf,
        Xa,
        fm,
        am,
        y,
        act,
        cfg,
        augment=augment,
        use_sampler=use_sampler,
        ravdess_weight=ravdess_weight,
    )


def _cleanup_loader(loader) -> None:
    """Shut down persistent DataLoader workers to prevent resource leaks across trials.

    Args:
        loader: The :class:`~torch.utils.data.DataLoader` whose worker processes
            should be terminated.
    """
    try:
        it = loader._iterator
        if it is not None and hasattr(it, "_shutdown_workers"):
            it._shutdown_workers()
    except Exception:
        pass
    finally:
        del loader


def _evaluate_detailed(model, loader, loss_fn, cfg, actor_threshold):
    """Run a single inference pass and return a full suite of evaluation metrics.

    Computes overall accuracy, macro-averaged F1 and recall (without sklearn),
    per-dataset accuracy for RAVDESS and CREMA-D, and Expected Calibration Error
    (ECE) — all in one forward pass to avoid redundant inference.

    ECE uses the standard equal-width 10-bin formulation:
    ``ECE = Σ_b (|B_b| / n) * |acc(B_b) − conf(B_b)|``.

    Args:
        model: The :class:`EmotionTransformer` to evaluate.
        loader: Validation :class:`~torch.utils.data.DataLoader`.
        loss_fn: Loss function (unused in scoring; kept for interface consistency).
        cfg: :class:`TrainConfig` instance.
        actor_threshold: Integer actor-ID boundary separating RAVDESS from CREMA-D.

    Returns:
        A 6-tuple ``(val_acc, macro_f1, macro_recall, ravdess_acc, crema_acc, ece)``
        where all values are Python floats.
    """
    was_training = model.training
    model.eval()

    all_preds, all_labels, all_confs = [], [], []
    try:
        with torch.no_grad():
            for xf, xa, fm, am, y in loader:
                logits, *_ = model(
                    xf.to(cfg.device),
                    xa.to(cfg.device),
                    fm.to(cfg.device),
                    am.to(cfg.device),
                )
                probs = torch.softmax(logits, dim=-1)
                conf, pred = probs.max(dim=-1)
                all_preds.append(pred.cpu())
                all_labels.append(y)
                all_confs.append(conf.cpu())
    finally:
        if was_training:
            model.train()

    preds = torch.cat(all_preds).numpy()
    labels = torch.cat(all_labels).numpy()
    confs = torch.cat(all_confs).numpy()
    actors = loader.dataset.act

    val_acc = float((preds == labels).mean())

    f1_scores = []
    recall_scores = []
    for c in range(cfg.num_classes):
        tp = int(((preds == c) & (labels == c)).sum())
        fp = int(((preds == c) & (labels != c)).sum())
        fn = int(((preds != c) & (labels == c)).sum())
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        denom = prec + recall
        f1_scores.append(2 * prec * recall / denom if denom > 0 else 0.0)
        recall_scores.append(recall)
    macro_f1 = float(np.mean(f1_scores))
    macro_recall = float(np.mean(recall_scores))

    rav_mask = actors < actor_threshold
    cre_mask = actors >= actor_threshold
    ravdess_acc = (
        float((preds[rav_mask] == labels[rav_mask]).mean()) if rav_mask.any() else 0.0
    )
    crema_acc = (
        float((preds[cre_mask] == labels[cre_mask]).mean()) if cre_mask.any() else 0.0
    )

    n = len(preds)
    ece = 0.0
    bin_edges = np.linspace(0.0, 1.0, _ECE_BINS + 1)
    for lo, hi in zip(bin_edges[:-1], bin_edges[1:]):
        mask = (confs >= lo) & (confs < hi)
        if not mask.any():
            continue
        bin_acc = (preds[mask] == labels[mask]).mean()
        bin_conf = confs[mask].mean()
        ece += (mask.sum() / n) * abs(bin_acc - bin_conf)

    return val_acc, macro_f1, macro_recall, ravdess_acc, crema_acc, float(ece)


def make_objective(cfg, data):
    """Build and return the Optuna objective closure for Phase A + Phase B tuning.

    Validation loaders and base class weights are constructed once and shared
    across all trials.  Train loaders are rebuilt per trial because
    ``WeightedRandomSampler`` is stateful and ``ravdess_weight_b`` is a tuned
    hyperparameter.

    The test loader is evaluated every ``TEST_EVAL_INTERVAL`` completed trials
    for observability only — its accuracy is stored as a ``user_attr`` and
    never enters the returned composite score.

    Args:
        cfg: :class:`TrainConfig` built from ``config/config.json``.
        data: Data dict as returned by :func:`load_data`.

    Returns:
        An Optuna-compatible objective callable ``(trial) -> float`` that
        returns the composite validation score to maximise.
    """
    val_loader_A = _make_loader(data["val_A"], cfg, augment=False, use_sampler=False)
    val_loader_B = _make_loader(data["val_B"], cfg, augment=False, use_sampler=False)
    val_loader_test = _make_loader(data["test"], cfg, augment=False, use_sampler=False)
    base_weights = compute_class_weights(cfg.class_counts, cfg.device)

    def objective(trial):
        set_seed(_GLOBAL_SEED)

        trial_cfg = {
            "boost_angry": trial.suggest_float("boost_angry", 0.8, 1.5),
            "boost_fearful": trial.suggest_float("boost_fearful", 2.0, 4.0),
            "boost_disgust": trial.suggest_float("boost_disgust", 1.0, 2.5),
            "boost_happy": trial.suggest_float("boost_happy", 0.8, 1.5),
            "boost_sad": trial.suggest_float("boost_sad", 2.8, 4.0),
            "boost_neutral": trial.suggest_float("boost_neutral", 0.5, 1.0),
            "sad_margin": trial.suggest_float("sad_margin", 0.18, 0.42),
            "disgust_margin": trial.suggest_float("disgust_margin", 0.10, 0.32),
            "sad_sep_w": trial.suggest_float("sad_sep_w", 0.02, 0.07),
            "fear_sep_w": trial.suggest_float("fear_sep_w", 0.01, 0.05),
            "disgust_sep_w": trial.suggest_float("disgust_sep_w", 0.01, 0.05),
            "lr_a": trial.suggest_float("lr_a", 1e-4, 5e-4, log=True),
            "lr_b": trial.suggest_float("lr_b", 5e-5, 5e-4, log=True),
            "label_smoothing": trial.suggest_float("label_smoothing", 0.03, 0.12),
            "dropout": trial.suggest_float("dropout", 0.10, 0.40),
            "ravdess_weight_b": trial.suggest_float("ravdess_weight_b", 1.0, 2.0),
            "swa_tail": trial.suggest_int("swa_tail", _SWA_TAIL_MIN, _SWA_TAIL_MAX),
            "mixup_alpha": trial.suggest_float("mixup_alpha", 0.05, 0.25),
            "mixup_prob": trial.suggest_float("mixup_prob", 0.05, 0.35),
        }

        t_cfg = copy.deepcopy(cfg)
        t_cfg.lr_a = trial_cfg["lr_a"]
        t_cfg.lr_b = trial_cfg["lr_b"]
        t_cfg.label_smoothing = trial_cfg["label_smoothing"]
        t_cfg.dropout = trial_cfg["dropout"]
        t_cfg.warmup_epochs = WARMUP_EPOCHS
        t_cfg.sad_margin = trial_cfg["sad_margin"]
        t_cfg.disgust_margin = trial_cfg["disgust_margin"]
        t_cfg.sad_sep_w = trial_cfg["sad_sep_w"]
        t_cfg.fear_sep_w = trial_cfg["fear_sep_w"]
        t_cfg.disgust_sep_w = trial_cfg["disgust_sep_w"]
        t_cfg.mixup_alpha = trial_cfg["mixup_alpha"]
        t_cfg.mixup_prob = trial_cfg["mixup_prob"]

        class_boost = torch.tensor(
            [
                trial_cfg["boost_angry"],
                trial_cfg["boost_fearful"],
                trial_cfg["boost_disgust"],
                trial_cfg["boost_happy"],
                trial_cfg["boost_sad"],
                trial_cfg["boost_neutral"],
            ],
            dtype=torch.float32,
            device=t_cfg.device,
        )
        loss_fn = FocalLoss(
            weight=base_weights * class_boost,
            gamma=1.0,
            label_smoothing=t_cfg.label_smoothing,
        )

        model = EmotionTransformer(t_cfg).to(t_cfg.device)

        tr_loader_A = _make_loader(
            data["train_A"],
            t_cfg,
            augment=True,
            use_sampler=True,
            ravdess_weight=cfg.ravdess_weight_a,
        )
        optimizer_A = AdamW(
            model.parameters(), lr=t_cfg.lr_a, weight_decay=t_cfg.weight_decay
        )
        scheduler_A = WarmupCosineScheduler(
            optimizer_A, WARMUP_EPOCHS, TRIAL_EPOCHS_A, t_cfg.lr_a
        )

        best_val_a = 0.0
        no_improve_a = 0

        try:
            for epoch in range(TRIAL_EPOCHS_A):
                scheduler_A.step(epoch)
                run_epoch(
                    model,
                    tr_loader_A,
                    loss_fn,
                    optimizer_A,
                    t_cfg,
                    train=True,
                    epoch=epoch,
                    epoch_offset=0,
                    use_mixup=False,
                )
                val_acc_a = run_epoch(
                    model,
                    val_loader_A,
                    loss_fn,
                    optimizer_A,
                    t_cfg,
                    train=False,
                    epoch=epoch,
                    epoch_offset=0,
                )[1]

                if val_acc_a > best_val_a + 1e-3:
                    best_val_a = val_acc_a
                    no_improve_a = 0
                else:
                    no_improve_a += 1

                trial.report(best_val_a, epoch)
                if trial.should_prune():
                    raise optuna.exceptions.TrialPruned()

                if no_improve_a >= _TRIAL_PATIENCE_A:
                    break
        finally:
            _cleanup_loader(tr_loader_A)

        swa_tail = trial_cfg["swa_tail"]
        swa_start_ep = max(0, TRIAL_EPOCHS_B - swa_tail)
        swa = SWAHandler(model, swa_start_epoch=swa_start_ep, device=t_cfg.device)

        tr_loader_B = _make_loader(
            data["train_B"],
            t_cfg,
            augment=True,
            use_sampler=True,
            ravdess_weight=trial_cfg["ravdess_weight_b"],
        )
        optimizer_B = AdamW(
            model.parameters(), lr=t_cfg.lr_b, weight_decay=t_cfg.weight_decay
        )
        scheduler_B = WarmupCosineScheduler(
            optimizer_B, WARMUP_EPOCHS, TRIAL_EPOCHS_B, t_cfg.lr_b
        )

        best_val_b = 0.0
        no_improve_b = 0
        val_b_history = []
        epochs_survived_b = 0

        try:
            for epoch in range(TRIAL_EPOCHS_B):
                scheduler_B.step(epoch)
                run_epoch(
                    model,
                    tr_loader_B,
                    loss_fn,
                    optimizer_B,
                    t_cfg,
                    train=True,
                    epoch=epoch,
                    epoch_offset=TRIAL_EPOCHS_A,
                    use_mixup=True,
                )
                val_acc_b = run_epoch(
                    model,
                    val_loader_B,
                    loss_fn,
                    optimizer_B,
                    t_cfg,
                    train=False,
                    epoch=epoch,
                    epoch_offset=TRIAL_EPOCHS_A,
                )[1]

                val_b_history.append(val_acc_b)
                swa.update(model, epoch)
                epochs_survived_b += 1

                if val_acc_b > best_val_b + 1e-3:
                    best_val_b = val_acc_b
                    no_improve_b = 0
                else:
                    no_improve_b += 1

                trial.report(best_val_b, TRIAL_EPOCHS_A + epoch)
                if trial.should_prune():
                    raise optuna.exceptions.TrialPruned()

                if no_improve_b >= _TRIAL_PATIENCE_B:
                    break
        finally:
            _cleanup_loader(tr_loader_B)

        del optimizer_A, optimizer_B
        gc.collect()

        used_swa = False
        if swa.n_averaged > 0 and epochs_survived_b >= _SWA_MIN_EPOCHS_SURVIVED:
            raw_state = copy.deepcopy(model.state_dict())
            raw_acc, raw_f1, raw_recall, raw_rav, raw_cre, raw_ece = _evaluate_detailed(
                model, val_loader_B, loss_fn, t_cfg, cfg.actor_id_threshold
            )
            raw_composite = (
                0.30 * raw_acc
                + 0.30 * raw_f1
                + 0.10 * raw_recall
                + 0.15 * raw_rav
                + 0.15 * raw_cre
                - 0.10 * raw_ece
            )
            swa.apply(model)
            swa_acc, swa_f1, swa_recall, swa_rav, swa_cre, swa_ece = _evaluate_detailed(
                model, val_loader_B, loss_fn, t_cfg, cfg.actor_id_threshold
            )
            swa_composite = (
                0.30 * swa_acc
                + 0.30 * swa_f1
                + 0.10 * swa_recall
                + 0.15 * swa_rav
                + 0.15 * swa_cre
                - 0.10 * swa_ece
            )
            if swa_composite >= raw_composite:
                used_swa = True
                val_acc, macro_f1, macro_recall, ravdess_acc, crema_acc, ece = (
                    swa_acc,
                    swa_f1,
                    swa_recall,
                    swa_rav,
                    swa_cre,
                    swa_ece,
                )
            else:
                model.load_state_dict(raw_state)
                val_acc, macro_f1, macro_recall, ravdess_acc, crema_acc, ece = (
                    raw_acc,
                    raw_f1,
                    raw_recall,
                    raw_rav,
                    raw_cre,
                    raw_ece,
                )
            del raw_state
        else:
            val_acc, macro_f1, macro_recall, ravdess_acc, crema_acc, ece = (
                _evaluate_detailed(
                    model, val_loader_B, loss_fn, t_cfg, cfg.actor_id_threshold
                )
            )

        _K = 5
        tail = val_b_history[-_K:] if len(val_b_history) >= _K else val_b_history
        instability = float(np.std(tail)) if len(tail) > 1 else 0.0
        instability_penalty = min(instability, 0.03)

        test_acc = -1.0
        if trial.number % TEST_EVAL_INTERVAL == 0:
            _, test_acc = evaluate(model, val_loader_test, loss_fn, t_cfg)

        del model
        gc.collect()

        composite = (
            0.30 * val_acc
            + 0.30 * macro_f1
            + 0.10 * macro_recall
            + 0.15 * ravdess_acc
            + 0.15 * crema_acc
            - 0.05 * instability_penalty
            - 0.10 * ece
        )

        trial.set_user_attr("val_acc", val_acc)
        trial.set_user_attr("macro_f1", macro_f1)
        trial.set_user_attr("macro_recall", macro_recall)
        trial.set_user_attr("ravdess_acc", ravdess_acc)
        trial.set_user_attr("crema_acc", crema_acc)
        trial.set_user_attr("ece", ece)
        trial.set_user_attr("instability", instability)
        trial.set_user_attr("used_swa", used_swa)
        trial.set_user_attr("swa_n_averaged", swa.n_averaged)
        trial.set_user_attr("epochs_survived_b", epochs_survived_b)
        trial.set_user_attr("test_acc", test_acc)

        return composite

    return objective


def main():
    """Entry point for the hyperparameter search.

    Parses CLI arguments, loads config and data, creates or resumes an Optuna
    study, runs the optimisation, and logs a best-trial summary alongside a
    JSON config snippet ready to paste into ``config.json``.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--trials", type=int, default=30, help="Number of Optuna trials"
    )
    parser.add_argument("--resume", action="store_true", help="Resume existing study")
    parser.add_argument(
        "--timeout", type=int, default=None, help="Stop after N seconds"
    )
    args = parser.parse_args()

    set_seed(_GLOBAL_SEED)

    Path(BASE_DIR / "logs").mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(str(BASE_DIR / "logs" / "tune.log")),
            logging.StreamHandler(),
        ],
    )
    logger = logging.getLogger(__name__)

    with open(BASE_DIR / "config" / "config.json") as f:
        cfg_raw = json.load(f)

    cfg, data = load_data(cfg_raw)

    logger.info(
        f"Loaded data — "
        f"train_A: {len(data['train_A'][4])}  val_A: {len(data['val_A'][4])}  "
        f"train_B: {len(data['train_B'][4])}  val_B: {len(data['val_B'][4])}  "
        f"test: {len(data['test'][4])}"
    )
    logger.info(
        f"Running {args.trials} trials  "
        f"(Phase A: {TRIAL_EPOCHS_A} epochs, patience={_TRIAL_PATIENCE_A} | "
        f"Phase B: {TRIAL_EPOCHS_B} epochs, patience={_TRIAL_PATIENCE_B} | "
        f"SWA tail: {_SWA_TAIL_MIN}–{_SWA_TAIL_MAX} epochs)"
    )
    logger.info(
        "Objective = 0.30*val_acc + 0.30*macro_f1 + 0.10*macro_recall"
        " + 0.15*ravdess + 0.15*crema - 0.05*min(σ,0.03) - 0.10*ece"
    )
    logger.info(
        f"Test set evaluated every {TEST_EVAL_INTERVAL} trials (logged only, never optimised)"
    )

    storage = f"sqlite:///{STUDY_DB}"

    if args.resume:
        study = optuna.load_study(study_name=STUDY_NAME, storage=storage)
        logger.info(f"Resuming study — {len(study.trials)} trials already done")
    else:
        try:
            optuna.delete_study(study_name=STUDY_NAME, storage=storage)
            logger.info("Deleted existing study — starting fresh")
        except (KeyError, optuna.exceptions.StorageInternalError):
            pass
        study = optuna.create_study(
            study_name=STUDY_NAME,
            storage=storage,
            direction="maximize",
            pruner=optuna.pruners.MedianPruner(
                n_startup_trials=8,
                n_warmup_steps=18,
            ),
            load_if_exists=False,
        )

    def _flush_cache_callback(study, trial):
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    study.optimize(
        make_objective(cfg, data),
        n_trials=args.trials,
        timeout=args.timeout,
        show_progress_bar=True,
        callbacks=[_flush_cache_callback],
    )

    completed = [t for t in study.trials if t.value is not None]
    if not completed:
        logger.error(
            "No completed trials — all were pruned. "
            "Try increasing n_startup_trials or reducing pruner aggression."
        )
        return

    best = study.best_trial
    ua = best.user_attrs
    logger.info(f"\n{'='*20} BEST TRIAL {'='*20}")
    logger.info(f"Composite score:  {best.value:.4f}  (trial #{best.number})")
    logger.info(f"  val_acc:        {ua.get('val_acc',      float('nan')):.4f}")
    logger.info(f"  macro_f1:       {ua.get('macro_f1',     float('nan')):.4f}")
    logger.info(f"  macro_recall:   {ua.get('macro_recall', float('nan')):.4f}")
    logger.info(f"  ravdess_acc:    {ua.get('ravdess_acc',  float('nan')):.4f}")
    logger.info(f"  crema_acc:      {ua.get('crema_acc',    float('nan')):.4f}")
    logger.info(
        f"  ece:            {ua.get('ece',          float('nan')):.4f}  (penalty)"
    )
    logger.info(
        f"  instability:    {ua.get('instability',  float('nan')):.4f}  (penalty, raw σ)"
    )
    logger.info(
        f"  used_swa:       {ua.get('used_swa', '?')}  "
        f"(n_averaged={ua.get('swa_n_averaged', '?')}  "
        f"epochs_survived_b={ua.get('epochs_survived_b', '?')})"
    )
    logger.info(
        f"  test_acc:       {ua.get('test_acc', float('nan')):.4f}"
        f"  (logged only — not optimised)"
    )
    logger.info("Best hyperparameters:")
    for k, v in best.params.items():
        logger.info(f"  {k}: {v:.6f}" if isinstance(v, float) else f"  {k}: {v}")

    p = best.params
    snippet = {
        "training": {
            "lr_a": round(p["lr_a"], 6),
            "lr_b": round(p["lr_b"], 6),
            "label_smoothing": round(p["label_smoothing"], 4),
            "swa_tail": int(p["swa_tail"]),
        },
        "model": {
            "dropout": float(p["dropout"]),
        },
        "augmentation": {
            "mixup_alpha": round(p["mixup_alpha"], 4),
            "mixup_prob": round(p["mixup_prob"], 4),
        },
        "misc": {
            "class_boost": [
                round(p["boost_angry"], 3),
                round(p["boost_fearful"], 3),
                round(p["boost_disgust"], 3),
                round(p["boost_happy"], 3),
                round(p["boost_sad"], 3),
                round(p["boost_neutral"], 3),
            ]
        },
        "separation_losses": {
            "sad_margin": round(p["sad_margin"], 3),
            "disgust_margin": round(p["disgust_margin"], 3),
            "sad_sep_w": round(p["sad_sep_w"], 4),
            "fear_sep_w": round(p["fear_sep_w"], 4),
            "disgust_sep_w": round(p["disgust_sep_w"], 4),
        },
        "dataloader": {
            "ravdess_weight_b": round(p["ravdess_weight_b"], 3),
        },
    }

    print("\n" + "=" * 50)
    print("Copy these values into your config.json:")
    print("=" * 50)
    print(json.dumps(snippet, indent=2))

    out_path = BASE_DIR / "logs" / "best_hparams_ab.json"
    with open(out_path, "w") as f:
        json.dump(
            {
                "best_composite_score": best.value,
                "best_val_acc": ua.get("val_acc"),
                "best_macro_f1": ua.get("macro_f1"),
                "best_macro_recall": ua.get("macro_recall"),
                "best_ravdess_acc": ua.get("ravdess_acc"),
                "best_crema_acc": ua.get("crema_acc"),
                "best_ece": ua.get("ece"),
                "instability": ua.get("instability"),
                "used_swa": ua.get("used_swa"),
                "swa_n_averaged": ua.get("swa_n_averaged"),
                "epochs_survived_b": ua.get("epochs_survived_b"),
                "test_acc_logged": ua.get("test_acc"),
                **snippet,
            },
            f,
            indent=2,
        )
    logger.info(f"\nSaved to {out_path}")

    logger.info(f"\nTop {TEST_EVAL_TOP_K} trials (ranked by composite score):")
    top_k = sorted(completed, key=lambda t: t.value, reverse=True)[:TEST_EVAL_TOP_K]
    for t in top_k:
        ta = t.user_attrs
        logger.info(
            f"  Trial {t.number:3d} | composite={t.value:.4f} | "
            f"val={ta.get('val_acc', float('nan')):.4f}  "
            f"f1={ta.get('macro_f1', float('nan')):.4f}  "
            f"rec={ta.get('macro_recall', float('nan')):.4f}  "
            f"rav={ta.get('ravdess_acc', float('nan')):.4f}  "
            f"cre={ta.get('crema_acc', float('nan')):.4f}  "
            f"ece={ta.get('ece', float('nan')):.4f}  "
            f"test={ta.get('test_acc', float('nan')):.4f}  "
            f"swa={ta.get('used_swa', '?')}  "
            f"ep_b={ta.get('epochs_survived_b', '?')}"
        )


if __name__ == "__main__":
    main()
