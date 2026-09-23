import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// The worker reads the corpus straight off local disk with `node:fs` — there is
// no child process and no network call. Node builtins stay external
// (`platform: "node"`); the SDK is bundled in, which is the loader contract for
// workers. The UI bundle externalises React and the SDK, because the host
// supplies both at runtime.
const presets = createPluginBundlerPresets({
  workerEntry: "src/worker.ts",
  uiEntry: "src/ui/index.tsx",
});
const watch = process.argv.includes("--watch");

/**
 * `--no-sourcemap` is what the published package is built with.
 *
 * Nothing consumes maps at plugin runtime, they carry absolute build paths into a
 * public tarball, and they are most of its bytes — the worker map alone is larger
 * than the worker. They stay on for local work, where they are the whole point.
 */
const published = process.argv.includes("--no-sourcemap");
const forPublish = (preset) => (published ? { ...preset, sourcemap: false } : preset);

const workerCtx = await esbuild.context(forPublish(presets.esbuild.worker));
const manifestCtx = await esbuild.context(forPublish(presets.esbuild.manifest));
const uiCtx = await esbuild.context(forPublish(presets.esbuild.ui));

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
