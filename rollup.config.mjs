import terser from "@rollup/plugin-terser";
import ts from "rollup-plugin-ts";
import copy from "rollup-plugin-copy";
import del from "rollup-plugin-delete";
const isProduction = !process.env.ROLLUP_WATCH;

function basePlugins() {
  return [
    ts(),
    isProduction &&
      terser({
        keep_classnames: true,
        keep_fnames: true,
        output: {
          comments: false,
        },
      }),
    copy({
      targets: [{ src: ["dist/*.d.ts", "dist/*.d.mts"], dest: "dist/@camoflage/" }],
      hook: "generateBundle",
    }),
    del({
      targets: ["dist/*.d.ts", "dist/*.d.mts"],
      hook: "generateBundle",
    }),
  ];
}

export default [
  {
    external: ["@camoflage/helpers"],
    input: "src/index.ts",
    output: [
      {
        file: "dist/@camoflage/grpc.es.mjs",
        format: "es",
        sourcemap: isProduction,
      },
    ],
    plugins: basePlugins(),
    watch: { clearScreen: false },
  },
  {
    external: ["@camoflage/helpers"],
    input: "src/index.ts",
    output: [
      {
        file: "dist/@camoflage/grpc.es.js",
        format: "es",
        sourcemap: isProduction,
      },
    ],
    plugins: basePlugins(),
    watch: { clearScreen: false },
  },
  {
    external: ["@camoflage/helpers"],
    input: "src/core/CamoflageGrpc.ts",
    output: [
      {
        name: "CamoflageGrpc",
        file: "dist/@camoflage/grpc.cjs.js",
        format: "cjs",
        exports: "default",
        sourcemap: isProduction,
      },
    ],
    plugins: basePlugins(),
    watch: { clearScreen: false },
  },
];
