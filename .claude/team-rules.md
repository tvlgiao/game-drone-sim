<!-- Team workflow v2. To roll back to the previous workflow, delete the import line in CLAUDE.md (or run: git revert <this commit>). The pre-v2 state is tagged workflow-v1. -->
## Team roles and model routing

The main session (Claude Opus) manages and coordinates. It routes work by type:

| Work | Who | How |
|---|---|---|
| Management, coordination, integration, final review, user communication | Claude Opus (main session) | — |
| Deep analysis, UI/UX design research, architecture research, planning | Claude Opus (main) or Opus subagents | `Agent` with `model: "opus"` |
| Coding, test writing, testing, simple jobs, tasks with a clear, specific spec | Claude Sonnet subagents | `Agent` with `model: "sonnet"`, in a worktree |
| Cross-checking plans, adversarial review of designs and PRs | Codex CLI, MiMo CLI agents | run headless, e.g. `codex exec "<prompt>"`; read-only on the repo |
| 2D graphics, images (UI art, icons, store art, textures, level-card art) | OpenAI image API (`gpt-image-1`) or Gemini image API | scripts under `tools/gen/`, outputs reviewed before commit |
| Video from an image or a prompt (trailers, store previews) | ByteDance Seedance (Volcengine Ark API) | scripts under `tools/gen/` |
| 3D models, 3D assets, motion, rigs | Meshy (web or API) | export glTF/GLB, then the asset pipeline below |

Rules that go with the routing:

1. **Sonnet gets a spec, not a goal.** Before delegating to Sonnet, Opus writes the spec: files in scope, the
   acceptance criteria, the tests to add, ports, branch, and what not to touch. Vague or design-heavy work stays
   with Opus.
2. **One owner per file area.** Parallel agents get disjoint directories; shared hooks (`main.ts`, `game-view.ts`)
   change in small, isolated edits, and Opus merges.
3. **Opus verifies before it reports.** Every agent result is checked by Opus (screenshots looked at, numbers read,
   tests run) before it reaches the user. An agent saying "done" is not evidence.
4. **Cross-check plans and big PRs.** Plans for new systems and PRs too large for the bot reviewer go to Codex CLI /
   MiMo CLI for a second opinion; findings are evaluated on the code like any review (fix or rebut, never ignore).
   If a CLI is out of credit or missing, note it and fall back to an independent Opus review agent.
5. **Generated assets need provenance.** For every AI-generated image, video or 3D model, record the tool, model,
   prompt and date in `assets/PROVENANCE.md`, and check that tool's commercial-use terms. Never generate
   anything that imitates a real brand, logo, product or person.
6. **Asset budgets.** 3D assets ship as GLB with meshopt/Draco geometry and KTX2 textures; per-asset triangle and
   texture budgets per tier follow `docs/10-render-pipeline.md` (Quest ≤80 draws / ≤120k tris per frame
   outdoors). Every new asset gets an LOD and a Quest variant or is excluded on low.
7. **Secrets.** API keys (OpenAI, Gemini, Ark, Meshy, App Store Connect) live in the macOS Keychain or
   `~/.config`, never in the repo, never printed in logs or chat. Scripts read them via
   `security find-generic-password -w` or an env var set at runtime.
8. **Cost control.** Image, video and 3D generation calls are batched and capped per task. Spending beyond the
   cap needs the user's OK.
