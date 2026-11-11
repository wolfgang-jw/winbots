/**
 * src/agents/__tests__/match.test.ts
 * W1–W6：通配匹配原语（需求 §6.1 第 5–8 条）。
 */
import { describe, expect, test } from "bun:test";
import { matchesAny, matchWildcard } from "../match";

describe("matchWildcard", () => {
  test("W1 末尾 * 命中同前缀", () => {
    expect(matchWildcard("local__fileRead__*", "local__fileRead__read_file")).toBe(true);
    expect(matchWildcard("local__fileRead__*", "local__fileRead__list_directory")).toBe(true);
  });

  test("W2 前缀多一个字符则不命中（需求 §6.1 第 6 条）", () => {
    expect(matchWildcard("local__fileRead__*", "local__fileReadX__y")).toBe(false);
    expect(matchWildcard("local__fileRead__*", "local__fileRea__read")).toBe(false);
  });

  test("W3 精确匹配", () => {
    expect(matchWildcard("examples/log_triage", "examples/log_triage")).toBe(true);
    expect(matchWildcard("examples/log_triage", "examples/log_triage_x")).toBe(false);
  });

  test("W4 中间 * 按普通字符比较，不当通配（需求 §6.1 第 7 条）", () => {
    expect(matchWildcard("local__*__read_file", "local__x__read_file")).toBe(false);
    expect(matchWildcard("local__*__read_file", "local__*__read_file")).toBe(true);
  });

  test("补充：空串不命中；单 * 命中一切；正则元字符按字面比较", () => {
    expect(matchWildcard("", "anything")).toBe(false);
    expect(matchWildcard("*", "anything")).toBe(true);
    expect(matchWildcard("a.b", "axb")).toBe(false);
    expect(matchWildcard("a.b", "a.b")).toBe(true);
  });
});

describe("matchesAny", () => {
  test("W5 null → false（null 不等于「全放行」）", () => {
    expect(matchesAny(null, "anything")).toBe(false);
  });

  test("W6 空数组 → false（空白名单什么都不放行）", () => {
    expect(matchesAny([], "anything")).toBe(false);
  });

  test("补充：任一命中即命中（OR）", () => {
    expect(matchesAny(["a", "b*"], "bcd")).toBe(true);
    expect(matchesAny(["a", "b*"], "zzz")).toBe(false);
  });
});
