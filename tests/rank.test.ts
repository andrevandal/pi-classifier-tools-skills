import assert from "node:assert/strict";
import { test } from "node:test";

import { rankSkills } from "../src/rank.ts";

test("ranking matches accented words and ignores accents in the prompt", () => {
  const skills = [
    { name: "deploy", description: "publicar o site em produção" },
    { name: "pdf", description: "read and write PDF files" },
  ];
  const [best] = rankSkills("preciso publicar em producao", skills);
  assert.equal(best?.skill.name, "deploy");
  assert.ok(best!.score > 0);
});
