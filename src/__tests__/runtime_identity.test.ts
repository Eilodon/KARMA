import { describe, it, expect, beforeEach } from "vitest";
import { isTrustedRuntime, markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";

describe("runtime_identity — fail-closed trusted main-runtime marker", () => {
  beforeEach(() => resetTrustedRuntimeForTest());

  it("is untrusted by default (fail-closed: absence proves nothing)", () => {
    expect(isTrustedRuntime()).toBe(false);
  });

  it("becomes trusted only after markTrustedRuntime()", () => {
    expect(isTrustedRuntime()).toBe(false);
    markTrustedRuntime();
    expect(isTrustedRuntime()).toBe(true);
  });

  it("resetTrustedRuntimeForTest restores the untrusted default", () => {
    markTrustedRuntime();
    resetTrustedRuntimeForTest();
    expect(isTrustedRuntime()).toBe(false);
  });
});
