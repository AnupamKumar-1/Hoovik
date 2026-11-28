import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.js"],
    include: ["src/**/*.test.{js,jsx}", "tests/**/*.test.{js,jsx}"],
    coverage: {
      provider: "v8",
      include: ["src/ai/services/**/*.js", "src/hooks/useHybridSummary.js", "src/components/PrivacyReceipt.jsx"],
      exclude: ["src/ai/services/**/*.test.js"],
      reporter: ["text-summary", "text"],
      thresholds: {
        "src/ai/services/policy.js": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "src/ai/services/validator.js": { statements: 95, branches: 90, functions: 100, lines: 95 },
        "src/ai/services/prepare.js": { statements: 95, branches: 85, functions: 100, lines: 95 },
        "src/ai/services/insights.js": { statements: 95, branches: 85, functions: 100, lines: 95 },
        "src/ai/services/adapter.js": { statements: 95, branches: 85, functions: 100, lines: 95 },
        "src/ai/services/errors.js": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "src/ai/services/hybrid.js": { statements: 95, branches: 90, functions: 90, lines: 95 },
        "src/ai/services/model.js": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "src/ai/services/prompt.js": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "src/ai/services/queue.js": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/ai/services/summaryMachine.js": { statements: 100, branches: 85, functions: 100, lines: 100 },
        "src/ai/services/witness.js": { statements: 95, branches: 90, functions: 100, lines: 95 },
        "src/ai/services/telemetry.js": { statements: 90, branches: 90, functions: 100, lines: 90 },
        "src/hooks/useHybridSummary.js": { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
