import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import RedactionPreview from "./RedactionPreview.jsx";
import { buildCloudPreview } from "../ai/services/cloudPreview.js";
import { piiMeeting, shortMeeting } from "../ai/golden/index.js";

afterEach(cleanup);

describe("RedactionPreview", () => {
  it("renders nothing without a preview", () => {
    for (const bad of [undefined, null, {}, { rows: "x" }]) {
      const { container, unmount } = render(<RedactionPreview preview={bad} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("shows original and redacted text side by side with counts by category", () => {
    render(<RedactionPreview preview={buildCloudPreview(piiMeeting.segments)} />);
    const region = screen.getByRole("region", { name: "What will be sent" });
    expect(within(region).getByText("Original (stays here)")).toBeInTheDocument();
    expect(within(region).getByText("Sent to the cloud")).toBeInTheDocument();
    const table = within(region).getByRole("table", { name: "Original and redacted text" });
    expect(table).toHaveTextContent("maria.lopez@northwind-legal.example"); // original column
    expect(table).toHaveTextContent("<EMAIL_1>"); // redacted column
    const counts = within(region).getByRole("list", { name: "Replaced by category" });
    expect(counts).toHaveTextContent("Email addresses1");
    expect(counts).toHaveTextContent("Phone numbers1");
    expect(counts).toHaveTextContent("Money amounts1");
    expect(counts).toHaveTextContent("Links1");
    expect(counts).toHaveTextContent("Ids and long numbers2");
  });

  it("always says it is best effort", () => {
    render(<RedactionPreview preview={buildCloudPreview(piiMeeting.segments)} />);
    expect(screen.getByText(/Best-effort, not anonymisation/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated from simple rules/)).toBeInTheDocument();
  });

  it("warns on high sensitivity with text as well as colour", () => {
    render(<RedactionPreview preview={buildCloudPreview(piiMeeting.segments)} />);
    const region = screen.getByRole("region", { name: "What will be sent" });
    expect(within(region).getByText("High sensitivity")).toBeInTheDocument();
    expect(within(region).getByText(/This transcript looks sensitive/)).toBeInTheDocument();
    expect(within(region).getByText(/Keeping it on this device is the safer choice/)).toBeInTheDocument();
    expect(region.querySelector("[data-level='high']")).not.toBeNull();
  });

  it("shows no warning for a low-sensitivity transcript and says when nothing was replaced", () => {
    render(<RedactionPreview preview={buildCloudPreview([{ speaker: "Unknown", start: 0, end: 1, text: "Nothing sensitive here." }])} />);
    expect(screen.getByText("Low sensitivity")).toBeInTheDocument();
    expect(screen.queryByText(/looks sensitive/)).toBeNull();
    expect(screen.getByText("Nothing was found to remove. The text below is sent as it is.")).toBeInTheDocument();
    expect(screen.getByText("No lines changed.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Replaced by category" })).toBeNull();
  });

  it("shows changed lines by default and every line on request", () => {
    const preview = buildCloudPreview([
      { speaker: "Unknown", start: 0, end: 1, text: "Plain line one." },
      { speaker: "Unknown", start: 1, end: 2, text: "Mail a@b.example now." },
      { speaker: "Unknown", start: 2, end: 3, text: "Plain line three." },
    ]);
    render(<RedactionPreview preview={preview} />);
    expect(screen.queryByText(/Plain line one/)).toBeNull();
    expect(screen.getAllByText(/Mail/).length).toBe(2);
    const toggle = screen.getByRole("button", { name: "Show all 3 lines" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(screen.getAllByText(/Plain line one/).length).toBe(2);
    expect(screen.getByRole("button", { name: "Show changed lines only" })).toHaveAttribute("aria-pressed", "true");
  });

  it("caps the number of rows rendered and says how many are not shown", () => {
    const rows = buildCloudPreview(shortMeeting.segments);
    render(<RedactionPreview preview={rows} maxRows={3} />);
    expect(screen.getByText(/more lines? not shown/)).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBe(1 + 3);
  });

  it("singular wording for one replaced item", () => {
    render(<RedactionPreview preview={buildCloudPreview([{ speaker: "Unknown", start: 0, end: 1, text: "Mail a@b.example." }])} />);
    expect(screen.getByText("1 item replaced with placeholders before sending.")).toBeInTheDocument();
  });
});
