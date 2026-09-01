import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultJobAnnouncementBody,
  resolveJobAnnouncementBody,
} from "./job-announcement-copy.ts";

test("the default existing-pool announcement uses the personal link without implying assignment", () => {
  const body = defaultJobAnnouncementBody("  성수   새벽 배송  ");

  assert.match(body, /성수 새벽 배송/);
  assert.match(body, /#\{이름\}/);
  assert.match(body, /#\{맞춤링크\}/);
  assert.match(body, /관심 표시는 배정·근무 확정이 아니며/);
  assert.match(body, /매니저가 확인 후 연락/);
  assert.doesNotMatch(body, /배정됐|확정됐|출근하세요/);
});

test("a manager-reviewed SMS draft is the exact copy used when it contains the personal link", () => {
  const draft = "  #{이름}님, 아래 공고를 확인해 주세요.\n#{맞춤링크}\n  ";

  assert.equal(
    resolveJobAnnouncementBody({ jobTitle: "성수 배송", smsDraft: draft }),
    "#{이름}님, 아래 공고를 확인해 주세요.\n#{맞춤링크}",
  );
});

test("legacy SMS without the personal link falls back instead of sending an unusable draft", () => {
  const body = resolveJobAnnouncementBody({
    jobTitle: "강남 백업 배송",
    smsDraft: "관심 있으시면 '지원'이라고 답장해 주세요.",
  });

  assert.match(body, /강남 백업 배송/);
  assert.match(body, /#\{맞춤링크\}/);
  assert.doesNotMatch(body, /'지원'이라고 답장/);
});
