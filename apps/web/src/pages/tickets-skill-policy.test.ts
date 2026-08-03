import { expect, test } from "vitest";
import * as tickets from "./tickets.ts";

test("required project skills remain resolved and non-removable even when overrides are allowed", () => {
  expect(tickets.skillPresentation({
    attachment_type: "required", required: true, allow_ticket_override: true,
    manual_selected: false, excluded: true,
  })).toEqual({
    automatic: false, projectAttached: true, required: true, overridable: false,
    selected: true, removable: false, badge: "required",
  });
});

test("only overridable automatic project skills honor ticket exclusions", () => {
  expect(tickets.skillPresentation({
    attachment_type: "automatic", required: false, allow_ticket_override: true,
    manual_selected: false, excluded: true,
  })).toMatchObject({ selected: false, removable: true, overridable: true });
});
