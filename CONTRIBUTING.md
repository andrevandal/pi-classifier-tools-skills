# Contributing

Thanks for helping. The code is small and tested; the open problem is **model quality**.
A base Laya checkpoint is close to chance on this plugin's questions (see
[Trade-offs](README.md#trade-offs)), so most turns keep the full loadout. What moves the
project forward is labeled data, measurements and fine-tuned checkpoints, not more code.

Two backends, two kinds of help:

| | Laya (`convaiinnovations/laya`) | Jev (TypeSafe) |
| --- | --- | --- |
| Where it runs | locally (Python sidecar or HTTP server) | TypeSafe's hosted API |
| Can the community fine-tune it? | yes, open weights (Apache 2.0 upstream) | not by us; it is TypeSafe's hosted model |
| What helps most | labeled prompts, fine-tuned checkpoints, eval results | labeled prompts, eval results, accuracy reports |

## What the classifier decides

Each turn the plugin asks the classifier two kinds of typed question (`src/select.ts`):

1. **Tool profile**: one `choice` question. The default options are `answer` (read-only),
   `edit` (read-only + `edit`/`write`/`ast_edit`) and `full` (everything). Profiles must be
   nested, so the model should pick the **narrowest profile that still lets the agent do the
   job**.
2. **Skill relevance**: one yes/no (`noul`) question per skill.

Wrong narrowing costs more than no narrowing: taking `bash` away from a turn that needed it
is worse than leaving it. Weigh that when you label. When unsure, label the broader profile.

## 1. Contribute labeled prompts (needs no GPU)

Labels are JSONL, one prompt per line, same shape as [`bench/labels.jsonl`](bench/labels.jsonl):

```json
{"id":"q-bot-count","prompt":"...","expect":"answer"}
```

`expect` is the profile the prompt **needs**: `answer`, `edit` or `full`. Decide from what the
prompt requires, not from what you think the model will say.

```bash
npm run eval -- --mine --out my-labels.jsonl --since 30d   # first prompts from your past sessions
# add "expect" by hand to each line, then measure the current backend:
npm run eval -- --labels my-labels.jsonl --config my-config.json
```

Guidelines:

- **Redact first.** Mined prompts come from your real sessions. Remove secrets, tokens, hostnames,
  customer data and private paths before sharing. Never commit a file you have not read line by line.
- **Do not label your own mined prompts with the classifier's output.** That measures nothing.
- Include hard cases: read-only questions that sound like edits ("how would I change X?"),
  edits that need no commands, vague one-liners, non-English prompts.
- Keep a **held-out split**. Do not train on the prompts you report accuracy on.
- Volume matters: the eval script says 16 labels are too few to recommend a `tools.maxRisk`.
  Zero over-narrowing needs at least 73 labels to reach a 95% upper bound under 5%.

Skill-relevance labels have **no format or scorer yet**: `npm run eval` and `npm run bench`
do not judge skill choices (see the `skills.enabled` row in the README). If you want to
contribute them, open an issue first so we agree on a schema.

## 2. Report measurements

Run the eval on your own labels and post the result in an issue or PR:

- `npm run eval -- --labels <file> --json` (confusion matrix, coverage vs over-narrowing by `maxRisk`).
- Backend and model: Jev model id, or Laya version and checkpoint (`laya.__version__`, repo/subfolder, router on/off).
- Hardware and latency if you compare CPU against GPU. Note that fans and VRAM are a real cost
  on a desktop GPU; a latency win of a few hundred ms may not be worth it.
- What it does *not* cover: label count, languages, domain.

## 3. Fine-tune Laya

Fine-tuning belongs upstream's tooling. Follow the Laya project's own fine-tuning docs
(their notebook and CLI, see <https://github.com/NandhaKishorM/laya> and
<https://huggingface.co/convaiinnovations/laya>) rather than anything copied here, because
flags and file formats change between releases. Check the exact commands against the docs for
the version you use.

What this project needs from a fine-tune:

- Train on the **same questions the plugin sends** (the `choice` question from
  `tools.question` and the per-skill yes/no), or a bench that uses a different question will not
  transfer. Inspect `tools.question` and `src/select.ts` for the questions sent;
  `/loadout explain` reports decisions and scores, not raw prompt text.
- **Evaluate on held-out labels** with `npm run eval`, not on the training set. Calibration
  samples drawn from training items overstate accuracy.
- Compare against the **base checkpoint on the same labels**, and report both.
- Publish the checkpoint (for example on Hugging Face) with its license, the training label
  count and the eval report. Do not commit weights to this repository.
- Point the plugin at it with `laya.repo` / `laya.subfolder`. Note `laya.router: true`
  always serves the upstream checkpoints, so set `"router": false` to use your own repo or
  subfolder.

## 4. Jev

Jev is a hosted model, so contributions are measurements and labels, not weights:

- Run `npm run eval` with `"backend": "jev"` and `TYPESAFE_API_KEY` set, using the same label
  file you used for Laya. Post both reports so the two backends are comparable.
- Remember what leaves your machine with Jev: the prompt (clipped to `maxPromptChars`) and skill
  names and descriptions. Do not run it on labels you are not allowed to send to a third party.
- Tell us if Jev's answers differ by question wording; a prompt-engineering change to
  `tools.question.instructions` or `criteria` is a valid contribution.

## 5. Code changes

```bash
npm install
npm test
npm run typecheck
npm run lint
```

- Keep `src/select.ts` pure (no I/O).
- A selection must remain a **subset of the baseline**, and "don't know" must keep everything.
  Do not weaken those guarantees (see [Guarantees](README.md#guarantees)).
- Add a test for behavior changes that a user could see. Do not add tests that only restate the
  implementation.
- The Jev/Laya clients and the Laya worker come from
  [pi-classifier-router](https://gitlab.com/ejstembler/pi-classifier-router) (MIT). Fixes that
  belong there should go there as well.

## Pull request checklist

- [ ] `npm test`, `npm run typecheck` and `npm run lint` pass.
- [ ] Label files are redacted and each line has `id`, `prompt` and `expect`.
- [ ] Reported accuracy comes from held-out labels, with label count and backend stated.
- [ ] No secrets, private paths or model weights in the diff.
- [ ] README updated if you changed config keys or defaults.

## License

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
Labels you submit must be yours to share under it.
