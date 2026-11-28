import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useHybridSummary } from "./useHybridSummary.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const segments = [{ speaker: "A", text: "hello", start: 0, end: 1 }];
const done = { status: "done", analysis: { summary: "ok" } };

describe("useHybridSummary", () => {
  it("runs from idle to done, passing policy, segments and no consent", async () => {
    const summarize = vi.fn(async ({ onEvent }) => {
      onEvent({ type: "stage", stage: "initialising" });
      onEvent({ type: "init-progress", value: 0.5 });
      onEvent({ type: "stage", stage: "generating", chunk: 1, total: 1 });
      return done;
    });
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    expect(result.current.state.status).toBe("idle");
    await act(async () => { await result.current.run({ segments, policy: "local-only" }); });
    expect(result.current.state).toMatchObject({ status: "done", analysis: { summary: "ok" } });
    expect(summarize.mock.calls[0][0]).toMatchObject({ segments, policy: "local-only", phase: "local", cloudConsent: false });
  });

  it("shows initialising with download progress, then generating", async () => {
    const gate = deferred();
    let emit;
    const summarize = vi.fn(({ onEvent }) => { emit = onEvent; return gate.promise; });
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    act(() => { result.current.run({ segments, policy: "local-only" }); });
    expect(result.current.state.status).toBe("initialising");
    act(() => emit({ type: "init-progress", value: 0.25 }));
    expect(result.current.state.progress).toBe(0.25);
    act(() => emit({ type: "stage", stage: "generating", chunk: 2, total: 3 }));
    expect(result.current.state).toMatchObject({ status: "generating", chunk: { index: 2, total: 3 } });
    await act(async () => { gate.resolve(done); await gate.promise; });
    expect(result.current.state.status).toBe("done");
  });

  it("a second run while one is in flight is ignored (one request only)", async () => {
    const gate = deferred();
    const summarize = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    act(() => { result.current.run({ segments, policy: "local-only" }); });
    act(() => { result.current.run({ segments, policy: "local-only" }); });
    expect(summarize).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve(done); await gate.promise; });
    expect(result.current.state.status).toBe("done");
  });

  it("ask flow: consent required -> approve runs the cloud phase with consent", async () => {
    const summarize = vi.fn()
      .mockResolvedValueOnce({ status: "consent-required", reason: "local-unavailable", error: { code: "LOCAL_UNAVAILABLE", message: "m" } })
      .mockResolvedValueOnce(done);
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    await act(async () => { await result.current.run({ segments, policy: "ask-before-cloud" }); });
    expect(result.current.state.status).toBe("consent-required");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0]).toMatchObject({ phase: "local", cloudConsent: false });
    await act(async () => { await result.current.approveCloud(); });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[1][0]).toMatchObject({ policy: "ask-before-cloud", phase: "cloud", cloudConsent: true });
    expect(result.current.state.status).toBe("done");
  });

  it("approveCloud does nothing unless consent is currently required", async () => {
    const summarize = vi.fn(async () => done);
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    await act(async () => { await result.current.approveCloud(); }); // idle, no previous run
    expect(summarize).not.toHaveBeenCalled();
    await act(async () => { await result.current.run({ segments, policy: "local-only" }); });
    await act(async () => { await result.current.approveCloud(); }); // done, not consent-required
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("declining consent returns to idle and approve is then inert", async () => {
    const summarize = vi.fn(async () => ({ status: "consent-required", reason: "local-unavailable" }));
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    await act(async () => { await result.current.run({ segments, policy: "ask-before-cloud" }); });
    act(() => result.current.declineCloud());
    expect(result.current.state.status).toBe("idle");
    await act(async () => { await result.current.approveCloud(); });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("failed -> retry runs the local phase again without consent", async () => {
    const summarize = vi.fn()
      .mockResolvedValueOnce({ status: "failed", error: { code: "MALFORMED_OUTPUT", message: "m" } })
      .mockResolvedValueOnce(done);
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    await act(async () => { await result.current.run({ segments, policy: "local-only" }); });
    expect(result.current.state.status).toBe("failed");
    await act(async () => { await result.current.retry(); });
    expect(result.current.state.status).toBe("done");
    expect(summarize.mock.calls[1][0]).toMatchObject({ phase: "local", cloudConsent: false });
  });

  it("retry with no previous run does nothing", async () => {
    const summarize = vi.fn();
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    await act(async () => { await result.current.retry(); });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("a thrown service error becomes a failed state, not a crash, and later runs still work", async () => {
    const summarize = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(done);
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    await act(async () => { await result.current.run({ segments, policy: "local-only" }); });
    expect(result.current.state).toMatchObject({ status: "failed", error: { code: "UNKNOWN" } });
    await act(async () => { await result.current.run({ segments, policy: "local-only" }); });
    expect(result.current.state.status).toBe("done");
  });

  it("reset during a run drops the late result and late events", async () => {
    const gate = deferred();
    let emit;
    const summarize = vi.fn(({ onEvent }) => { emit = onEvent; return gate.promise; });
    const { result } = renderHook(() => useHybridSummary({ service: { summarize } }));
    act(() => { result.current.run({ segments, policy: "local-only" }); });
    act(() => result.current.reset());
    expect(result.current.state.status).toBe("idle");
    act(() => emit({ type: "init-progress", value: 0.9 }));
    await act(async () => { gate.resolve(done); await gate.promise; });
    expect(result.current.state.status).toBe("idle");
  });

  it("an unmounted hook does not update state after the result arrives", async () => {
    const gate = deferred();
    const summarize = vi.fn(() => gate.promise);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useHybridSummary({ service: { summarize } }));
    act(() => { result.current.run({ segments, policy: "local-only" }); });
    unmount();
    await act(async () => { gate.resolve(done); await gate.promise; });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("falls back to the shared hybrid service when none is injected", async () => {
    const { getHybridService } = await import("../ai/services/hybrid.js");
    const spy = vi.spyOn(getHybridService(), "summarize").mockResolvedValue(done);
    const { result } = renderHook(() => useHybridSummary());
    await act(async () => { await result.current.run({ segments, policy: "local-only" }); });
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
