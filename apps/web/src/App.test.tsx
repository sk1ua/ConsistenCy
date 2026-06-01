import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("is a renderable React component", () => {
    expect(App).toBeTypeOf("function");
  });
});
