import { describe, expect, it } from "vitest";
import { BaseCodeGroupPlan } from "./BaseCodeGroupPlan";

describe("BaseCodeGroupPlan", () => {
  it("groups the submitted variants of one number onto a single base code", () => {
    const plan = new BaseCodeGroupPlan();
    plan.seed(["/in/ABC-111.mp4", "/in/ABC-111-C.mp4", "/in/ABC-111-UC.mp4", "/in/XYZ-222.mp4"]);

    expect(plan.pendingMembers("ABC-111")).toBe(3);
    expect(plan.pendingMembers("abc-111")).toBe(3);
    expect(plan.pendingMembers("XYZ-222")).toBe(1);
    expect(plan.pendingMembers("NOPE-1")).toBe(0);
  });

  it("stays pending until every submitted file has finished", () => {
    const plan = new BaseCodeGroupPlan();
    plan.seed(["/in/ABC-111.mp4", "/in/ABC-111-UC.mp4"]);

    plan.complete("/in/ABC-111.mp4");
    expect(plan.pendingMembers("ABC-111")).toBe(1);
    expect(plan.hasPending()).toBe(true);

    plan.complete("/in/ABC-111-UC.mp4");
    expect(plan.hasPending()).toBe(false);
  });

  it("ignores repeated completions and files it never saw", () => {
    const plan = new BaseCodeGroupPlan();
    plan.seed(["/in/ABC-111.mp4"]);

    plan.complete("/in/ABC-111.mp4");
    plan.complete("/in/ABC-111.mp4");
    plan.complete("/in/never-submitted.mp4");

    expect(plan.hasPending()).toBe(false);
  });

  it("lets a retry rejoin the group it was completed out of", () => {
    const plan = new BaseCodeGroupPlan();
    plan.seed(["/in/ABC-111.mp4", "/in/ABC-111-C.mp4"]);
    plan.complete("/in/ABC-111.mp4");
    plan.complete("/in/ABC-111-C.mp4");
    expect(plan.hasPending()).toBe(false);

    plan.add("/in/ABC-111-C.mp4");
    expect(plan.pendingMembers("ABC-111")).toBe(1);
    expect(plan.hasPending()).toBe(true);
  });

  it("honors the filename ignore tokens the session was configured with", () => {
    const plan = new BaseCodeGroupPlan();
    plan.seed(["/in/[hello]ABC-111-C.mp4"], ["[hello]"]);

    expect(plan.pendingMembers("ABC-111")).toBe(1);
  });

  it("clears back to empty", () => {
    const plan = new BaseCodeGroupPlan();
    plan.seed(["/in/ABC-111.mp4"]);
    plan.clear();

    expect(plan.hasPending()).toBe(false);
    expect(plan.pendingMembers("ABC-111")).toBe(0);
  });
});
