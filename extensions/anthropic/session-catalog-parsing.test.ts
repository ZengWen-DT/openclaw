import { expect, it } from "vitest";
import { decodeOffset, encodeOffset } from "./session-catalog-parsing.js";

it.each(["catalog", "transcript"])("accepts only emitted %s offset cursors", (label) => {
  const cursor = encodeOffset(2);
  const extra = Buffer.from(JSON.stringify({ offset: 2, extra: true })).toString("base64url");
  expect(decodeOffset(cursor, label)).toBe(2);
  expect(decodeOffset(undefined, label)).toBe(0);
  for (const altered of [`${cursor}!`, `${cursor}=`, ` ${cursor} `, extra]) {
    expect(() => decodeOffset(altered, label)).toThrow(`${label} cursor is invalid`);
  }
});
