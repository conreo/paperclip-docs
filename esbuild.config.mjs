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

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
