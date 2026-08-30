#!/usr/bin/env bun
// Compiles Tack into a single, self-contained executable (embeds the Bun
// runtime + all JS). Output: dist/tack.
//
//   bun run build   # -> dist/tack
//
// `react-devtools-core` is an optional peer that Ink only imports when
// DEV=true. A standalone binary has no node_modules to resolve it from, so we
// replace it with an empty stub — that dev-only code path never runs here.

const result = await Bun.build({
  entrypoints: ["./bin/tack.ts"],
  compile: { outfile: "dist/tack" },
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export default {};",
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${result.outputs.map((o) => o.path).join(", ")}`);
