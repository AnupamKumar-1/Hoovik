"""
tune_xgb.py — Optuna hyperparameter search for the XGBoost emotion classifier.

Strategy
--------
* TPE sampler with MedianPruner for early stopping of bad trials.
* Each trial builds PCA-reduced features (same pipeline as train_xgb.py),
  trains XGBoost with val mlogloss as the objective, and reports the best
  val score found via early-stopping.
* At the end the best params are written back into config.json under the
  "xgb" key so train_xgb.py picks them up immediately.

Usage
-----
    # default: 60 trials, 8 pruning start-up trials
    python tune_xgb.py

    # custom
    python tune_xgb.py --trials 120 --startup 15 --jobs 1 --no-pca

    # resume a previous study (DB persisted in logs/ by default)
    python tune_xgb.py --study-name xgb_emotion

    # resume from an explicit storage path
    python tune_xgb.py --storage sqlite:////abs/path/to/optuna_xgb.db --study-name xgb_emotion

CLI flags
---------
  --trials       Total Optuna trials to run                              (default: 60)
  --startup      MedianPruner warmup trials                              (default: 8)
  --jobs         Parallel jobs (-1 = all CPUs)                          (default: 1)
  --no-pca       Disable PCA even if config says true
  --storage      Optuna storage URL; defaults to sqlite:///<log_dir>/optuna_xgb.db
  --study-name   Optuna study name                                       (default: xgb_emotion)
  --no-write     Skip writing best params to config.json
"""

import argparse
import json
import logging
import time
from pathlib import Path

import numpy as np
import optuna
import xgboost as xgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import joblib

from train_xgb import (  # noqa: E402
    BASE_DIR,
    MODALITY_AUDIO_ONLY,
    MODALITY_VIDEO_ONLY,
    MODALITY_BOTH,
    load_config,
    setup_logging,
    build_features,
    preprocess_features,
    compute_sample_weights,
    plot_confusion,
    plot_importance,
)

TUNE_LOG_FILE = "tune_xgb.log"
TUNE_MAX_ESTIMATORS = 3000
TUNE_EARLY_STOPPING = 100


def make_objective(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_va: np.ndarray,
    y_va: np.ndarray,
    weights: np.ndarray,
    num_classes: int,
    seed: int,
    logger: logging.Logger,
):
    """Create an Optuna objective closure for XGBoost hyperparameter search.

    The returned callable minimises validation mlogloss. XGBoost's built-in
    pruning callback reports per-round scores so Optuna's MedianPruner can
    terminate unpromising trials early.

    Args:
        X_tr: Training feature matrix of shape (n_train, n_features).
        y_tr: Training labels of shape (n_train,).
        X_va: Validation feature matrix of shape (n_val, n_features).
        y_va: Validation labels of shape (n_val,).
        weights: Per-sample training weights of shape (n_train,).
        num_classes: Number of target classes.
        seed: Random seed for reproducibility.
        logger: Logger instance for trial-level diagnostics.

    Returns:
        Callable[[optuna.Trial], float]: Objective function that returns
        the best validation mlogloss for a given trial.
    """

    def objective(trial: optuna.Trial) -> float:
        params = {
            "max_depth": trial.suggest_int("max_depth", 3, 10),
            "min_child_weight": trial.suggest_int("min_child_weight", 1, 10),
            "gamma": trial.suggest_float("gamma", 0.0, 2.0),
            "subsample": trial.suggest_float("subsample", 0.4, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.3, 1.0),
            "colsample_bylevel": trial.suggest_float("colsample_bylevel", 0.5, 1.0),
            "reg_alpha": trial.suggest_float("reg_alpha", 1e-4, 1.0, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 0.1, 10.0, log=True),
            "learning_rate": trial.suggest_float("learning_rate", 1e-3, 0.3, log=True),
            "n_estimators": TUNE_MAX_ESTIMATORS,
        }

        model = xgb.XGBClassifier(
            **params,
            objective="multi:softprob",
            num_class=num_classes,
            eval_metric="mlogloss",
            tree_method="hist",
            random_state=seed,
            missing=np.nan,
            callbacks=[
                optuna.integration.XGBoostPruningCallback(
                    trial, "validation_0-mlogloss"
                )
            ],
        )

        model.fit(
            X_tr,
            y_tr,
            sample_weight=weights,
            eval_set=[(X_va, y_va)],
            early_stopping_rounds=TUNE_EARLY_STOPPING,
            verbose=False,
        )

        best_score = float(model.best_score)
        best_iter = int(model.best_iteration)
        trial.set_user_attr("best_iteration", best_iter)
        logger.info(
            f"Trial {trial.number:>4d} | mlogloss={best_score:.5f} "
            f"| best_iter={best_iter:>4d} "
            f"| lr={params['learning_rate']:.5f} depth={params['max_depth']} "
            f"sub={params['subsample']:.2f} col={params['colsample_bytree']:.2f}"
        )
        return best_score

    return objective


def retrain_best(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_va: np.ndarray,
    y_va: np.ndarray,
    X_te: np.ndarray,
    y_te: np.ndarray,
    act_te: np.ndarray,
    mod_te: np.ndarray,
    best_params: dict,
    num_classes: int,
    class_names: list,
    actor_threshold: int,
    seed: int,
    ckpt_dir: Path,
    log_dir: Path,
    pca,
    col_medians,
    normalize_confusion: bool,
    logger: logging.Logger,
) -> xgb.XGBClassifier:

    """Retrain XGBoost with the best Optuna parameters and evaluate on the test set.

    Combines train and validation splits for the final fit. The number of
    estimators is derived from ``best_iteration * 1.05`` when available,
    falling back to ``n_estimators`` from ``best_params``. Saves the model
    checkpoint, preprocessing artifacts, and diagnostic plots.

    Args:
        X_tr: Training feature matrix of shape (n_train, n_features).
        y_tr: Training labels of shape (n_train,).
        X_va: Validation feature matrix of shape (n_val, n_features).
        y_va: Validation labels of shape (n_val,).
        X_te: Test feature matrix of shape (n_test, n_features).
        y_te: Test labels of shape (n_test,).
        act_te: Actor IDs for test samples, used for dataset-level breakdown.
        mod_te: Modality flags for test samples.
        best_params: Hyperparameter dict from the best Optuna trial.
        num_classes: Number of target classes.
        class_names: Ordered list of class label strings.
        actor_threshold: Actor ID boundary separating RAVDESS from CREMA-D.
        seed: Random seed for reproducibility.
        ckpt_dir: Directory for saving the model and preprocessing artifacts.
        log_dir: Directory for saving evaluation plots.
        pca: Fitted PCA transformer, or ``None`` if PCA was disabled.
        col_medians: Column medians used for imputation during preprocessing.
        normalize_confusion: Whether to normalise the confusion matrix by row.
        logger: Logger instance for progress and evaluation output.

    Returns:
        xgb.XGBClassifier: Trained model fitted on the combined train+val set.
    """
    
    logger.info("\n" + "=" * 60)
    logger.info("FINAL RETRAIN WITH BEST PARAMS")
    logger.info("=" * 60)

    weights = compute_sample_weights(
        y_tr, np.zeros(len(y_tr), dtype=np.int64), num_classes
    )

    X_full = np.concatenate([X_tr, X_va], axis=0)
    y_full = np.concatenate([y_tr, y_va], axis=0)
    w_va = compute_sample_weights(
        y_va, np.zeros(len(y_va), dtype=np.int64), num_classes
    )
    w_full = np.concatenate([weights, w_va], axis=0)

    n_estimators = best_params.get("n_estimators", TUNE_MAX_ESTIMATORS)
    early_stop = best_params.pop("early_stopping_rounds", None)
    best_iter = best_params.pop("best_iteration", None)

    if best_iter is not None:
        final_n = max(100, int(best_iter * 1.05))
        logger.info(f"Using best_iteration={best_iter} → final n_estimators={final_n}")
    else:
        final_n = n_estimators

    model = xgb.XGBClassifier(
        **{k: v for k, v in best_params.items() if k != "n_estimators"},
        n_estimators=final_n,
        objective="multi:softprob",
        num_class=num_classes,
        eval_metric="mlogloss",
        tree_method="hist",
        random_state=seed,
        missing=np.nan,
    )
    model.fit(X_full, y_full, sample_weight=w_full, verbose=False)

    preds_te = model.predict(X_te)
    acc = (preds_te == y_te).mean()
    logger.info(f"\n{'=' * 20} TEST RESULTS {'=' * 20}")
    logger.info(f"OVERALL TEST ACC: {acc:.4f}")
    logger.info("\n" + classification_report(y_te, preds_te, target_names=class_names))

    for name, idx in [
        ("RAVDESS", act_te < actor_threshold),
        ("CREMA-D", act_te >= actor_threshold),
    ]:
        if idx.sum() == 0:
            continue
        logger.info(
            f"\n{name} test acc ({idx.sum()} samples): "
            f"{(preds_te[idx] == y_te[idx]).mean():.4f}"
        )
        logger.info(
            "\n"
            + classification_report(
                y_te[idx], preds_te[idx], target_names=class_names, zero_division=0
            )
        )

    logger.info(f"\n{'=' * 20} PER-MODALITY TEST RESULTS {'=' * 20}")
    for mod_val, mod_name in [
        (MODALITY_AUDIO_ONLY, "audio_only"),
        (MODALITY_VIDEO_ONLY, "video_only"),
        (MODALITY_BOTH, "both"),
    ]:
        idx = mod_te == mod_val
        if idx.sum() == 0:
            continue
        logger.info(
            f"{mod_name} ({idx.sum()} samples): "
            f"acc={(preds_te[idx] == y_te[idx]).mean():.4f}"
        )

    ckpt_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, ckpt_dir / "xgb_model.joblib")
    logger.info(f"Saved tuned model → {ckpt_dir / 'xgb_model.joblib'}")
    if pca is not None:
        joblib.dump(pca, ckpt_dir / "pca.joblib")
        np.save(ckpt_dir / "col_medians.npy", col_medians)
        logger.info("Saved pca.joblib + col_medians.npy")

    plot_confusion(
        y_te,
        preds_te,
        class_names,
        log_dir / "confusion_xgb_tuned.png",
        normalize=normalize_confusion,
    )
    plot_importance(
        model,
        log_dir / "feature_importance_xgb_tuned.png",
        importance_type="gain",
        top_n=30,
        logger=logger,
    )

    return model


def save_optuna_plots(
    study: optuna.Study, log_dir: Path, logger: logging.Logger
) -> None:
    """Render and save Optuna diagnostic plots to disk.

    Generates an optimisation history plot for all studies, and parameter
    importance and parallel-coordinate plots when at least 10 trials are
    available. Failures are logged as warnings rather than raised.

    Args:
        study: Completed Optuna study object.
        log_dir: Directory where plot PNGs will be written.
        logger: Logger instance for status and warning messages.
    """
    try:
        from optuna.visualization.matplotlib import (
            plot_optimization_history,
            plot_param_importances,
            plot_parallel_coordinate,
        )

        fig, ax = plt.subplots(figsize=(10, 5))
        plot_optimization_history(study, ax=ax)
        plt.tight_layout()
        plt.savefig(log_dir / "optuna_history.png", dpi=150)
        plt.close()

        if len(study.trials) >= 10:
            fig, ax = plt.subplots(figsize=(10, 6))
            plot_param_importances(study, ax=ax)
            plt.tight_layout()
            plt.savefig(log_dir / "optuna_param_importance.png", dpi=150)
            plt.close()

            fig, ax = plt.subplots(figsize=(14, 6))
            plot_parallel_coordinate(study, ax=ax)
            plt.tight_layout()
            plt.savefig(log_dir / "optuna_parallel_coordinate.png", dpi=150)
            plt.close()

        logger.info(f"Optuna plots saved to {log_dir}")
    except Exception as exc:
        logger.warning(f"Could not save Optuna plots: {exc}")


def update_config_with_best(
    best_params: dict,
    best_iteration: int,
    cfg_path: Path,
    logger: logging.Logger,
) -> None:
    """Merge the best Optuna parameters into config.json under the ``xgb`` key.

    All other top-level keys in the config are preserved. The number of
    estimators is set to ``max(500, best_iteration * 1.05)``.

    Args:
        best_params: Hyperparameter dict from the best Optuna trial.
        best_iteration: Best boosting round reported by XGBoost early stopping.
        cfg_path: Path to the config.json file to update in-place.
        logger: Logger instance for confirmation messages.
    """
    with open(cfg_path) as f:
        cfg = json.load(f)

    cfg["xgb"].update(
        {
            "max_depth": best_params["max_depth"],
            "min_child_weight": best_params["min_child_weight"],
            "gamma": round(best_params["gamma"], 6),
            "subsample": round(best_params["subsample"], 4),
            "colsample_bytree": round(best_params["colsample_bytree"], 4),
            "colsample_bylevel": round(best_params.get("colsample_bylevel", 1.0), 4),
            "reg_alpha": round(best_params["reg_alpha"], 6),
            "reg_lambda": round(best_params["reg_lambda"], 4),
            "learning_rate": round(best_params["learning_rate"], 6),
            "n_estimators": max(500, int(best_iteration * 1.05)),
        }
    )

    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
    logger.info(f"config.json updated with best Optuna params → {cfg_path}")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for the tuning script.

    Returns:
        argparse.Namespace: Parsed argument values.
    """
    p = argparse.ArgumentParser(description="Optuna XGBoost hyperparameter search")
    p.add_argument(
        "--trials", type=int, default=60, help="Total Optuna trials (default: 60)"
    )
    p.add_argument(
        "--startup", type=int, default=8, help="MedianPruner warmup trials (default: 8)"
    )
    p.add_argument(
        "--jobs", type=int, default=1, help="Parallel Optuna workers (default: 1)"
    )
    p.add_argument(
        "--no-pca", action="store_true", help="Disable PCA for this tuning run"
    )
    p.add_argument(
        "--storage",
        type=str,
        default=None,
        help=(
            "Optuna storage URL, e.g. sqlite:///path/to/optuna.db. "
            "Defaults to sqlite:///<log_dir>/optuna_xgb.db so the DB "
            "is always written inside the project logs folder."
        ),
    )
    p.add_argument(
        "--study-name",
        type=str,
        default="xgb_emotion",
        help="Optuna study name (default: xgb_emotion)",
    )
    p.add_argument(
        "--no-write",
        action="store_true",
        help="Skip writing best params back to config.json",
    )
    return p.parse_args()


def main() -> None:
    """Entry point for Optuna-based XGBoost hyperparameter tuning.

    Loads configuration and data, resolves the Optuna storage path to
    ``<log_dir>/optuna_xgb.db`` when ``--storage`` is not supplied, runs the
    Optuna study, logs the best trial, optionally updates config.json, and
    retrains a final model on the combined train+val split before evaluating
    on the held-out test set.
    """
    args = parse_args()

    cfg = load_config()
    cfg_path = BASE_DIR / "config" / "config.json"

    data_path = BASE_DIR / cfg["paths"]["dataset"]
    ckpt_dir = BASE_DIR / cfg["paths"]["checkpoints"]["xgb"]
    log_dir = BASE_DIR / cfg["paths"]["logs"]
    log_dir_path = Path(log_dir)
    log_dir_path.mkdir(parents=True, exist_ok=True)

    class_names = cfg["misc"]["class_names"]
    num_classes = cfg["model"]["num_classes"]
    seed = cfg["misc"]["seed"]
    use_pca = cfg["features"]["use_pca"] and not args.no_pca
    pca_dim = cfg["features"]["pca_dim"]
    actor_threshold = cfg["misc"]["actor_id_threshold"]
    normalize_confusion = cfg["misc"].get("normalize_confusion", True)

    logger = setup_logging(str(log_dir), TUNE_LOG_FILE)

    if args.storage is None:
        db_path = log_dir_path / "optuna_xgb.db"
        args.storage = f"sqlite:///{db_path.resolve()}"
        logger.info(f"Optuna storage defaulting to logs folder: {args.storage}")
    logger.info("=" * 60)
    logger.info("tune_xgb.py — Optuna hyperparameter search")
    logger.info(f"  trials={args.trials}  startup={args.startup}  jobs={args.jobs}")
    logger.info(f"  use_pca={use_pca}  pca_dim={pca_dim}  seed={seed}")
    logger.info(f"  study_name={args.study_name}  storage={args.storage}")
    logger.info("=" * 60)

    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")

    logger.info(f"Loading dataset from {data_path}")
    data = np.load(data_path)

    Xf_tr, Xa_tr = data["X_face_train"], data["X_audio_train"]
    fm_tr, am_tr = data["face_mask_train"], data["audio_mask_train"]
    y_tr, act_tr = data["y_train"], data["actor_train"]
    mod_tr = data["modality_train"]

    Xf_va, Xa_va = data["X_face_val"], data["X_audio_val"]
    fm_va, am_va = data["face_mask_val"], data["audio_mask_val"]
    y_va = data["y_val"]
    mod_va = data["modality_val"]

    Xf_te, Xa_te = data["X_face_test"], data["X_audio_test"]
    fm_te, am_te = data["face_mask_test"], data["audio_mask_test"]
    y_te, act_te = data["y_test"], data["actor_test"]
    mod_te = data["modality_test"]

    logger.info(f"Loaded — train: {len(y_tr)}  val: {len(y_va)}  test: {len(y_te)}")

    logger.info("Building features...")
    t0 = time.perf_counter()
    X_tr = build_features(Xf_tr, Xa_tr, fm_tr, am_tr, mod_tr)
    X_va = build_features(Xf_va, Xa_va, fm_va, am_va, mod_va)
    X_te = build_features(Xf_te, Xa_te, fm_te, am_te, mod_te)
    logger.info(f"Feature build: {time.perf_counter() - t0:.1f}s  shape={X_tr.shape}")

    X_tr, X_va, X_te, pca, col_medians, _ = preprocess_features(
        X_tr, X_va, X_te, use_pca, pca_dim, seed, logger
    )

    weights = compute_sample_weights(y_tr, mod_tr, num_classes)

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    sampler = optuna.samplers.TPESampler(seed=seed, n_startup_trials=args.startup)
    pruner = optuna.pruners.MedianPruner(
        n_startup_trials=args.startup,
        n_warmup_steps=50,
        interval_steps=10,
    )

    study = optuna.create_study(
        study_name=args.study_name,
        direction="minimize",
        sampler=sampler,
        pruner=pruner,
        storage=args.storage,
        load_if_exists=True,
    )

    objective = make_objective(
        X_tr, y_tr, X_va, y_va, weights, num_classes, seed, logger
    )

    logger.info(f"Starting Optuna search: {args.trials} trials...")
    t_study = time.perf_counter()
    study.optimize(
        objective, n_trials=args.trials, n_jobs=args.jobs, show_progress_bar=False
    )
    elapsed = time.perf_counter() - t_study
    logger.info(f"Optuna search complete in {elapsed:.1f}s")

    best = study.best_trial
    logger.info("\n" + "=" * 60)
    logger.info("BEST TRIAL")
    logger.info(f"  Number   : {best.number}")
    logger.info(f"  Val loss : {best.value:.5f}")
    logger.info(f"  Best iter: {best.user_attrs.get('best_iteration', 'n/a')}")
    logger.info("  Params:")
    for k, v in best.params.items():
        logger.info(f"    {k:30s}: {v}")
    logger.info("=" * 60)

    study_path = log_dir_path / "optuna_study.pkl"
    joblib.dump(study, study_path)
    logger.info(f"Optuna study saved → {study_path}")
    save_optuna_plots(study, log_dir_path, logger)

    best_iteration = best.user_attrs.get("best_iteration", TUNE_MAX_ESTIMATORS)
    if not args.no_write:
        update_config_with_best(dict(best.params), best_iteration, cfg_path, logger)
    else:
        logger.info("--no-write set: skipping config.json update.")

    best_params_for_retrain = dict(best.params)
    best_params_for_retrain["best_iteration"] = best_iteration

    retrain_best(
        X_tr,
        y_tr,
        X_va,
        y_va,
        X_te,
        y_te,
        act_te,
        mod_te,
        best_params_for_retrain,
        num_classes,
        class_names,
        actor_threshold,
        seed,
        ckpt_dir,
        log_dir_path,
        pca,
        col_medians,
        normalize_confusion,
        logger,
    )

    logger.info("DONE — tune_xgb complete.")


if __name__ == "__main__":
    main()
