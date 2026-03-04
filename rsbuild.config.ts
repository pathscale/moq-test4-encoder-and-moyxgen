import path from "node:path";
import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";

const solidPath = path.resolve(__dirname, "node_modules/solid-js");

export default defineConfig({
  plugins: [pluginBabel({ include: /\.(?:jsx|tsx|ts)$/ }), pluginSolid()],
  resolve: {
    alias: { "~": "./src" },
  },
  html: {
    template: "./index.html",
    title: "MoQ Test 4",
    mountId: "root",
  },
  dev: {
    hmr: true,
    liveReload: true,
    client: {
      overlay: false,
    },
  },
  server: {
    port: 3005,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    publicDir: {
      name: ".",
      copyOnBuild: false,
    },
  },
  tools: {
    rspack: {
      resolve: {
        symlinks: false,
        modules: [path.resolve(__dirname, "node_modules"), "node_modules"],
        alias: {
          "solid-js/web": `${solidPath}/web/dist/web.js`,
          "solid-js/store": `${solidPath}/store/dist/store.js`,
          "solid-js": `${solidPath}/dist/solid.js`,
        },
        conditionNames: ["browser", "import", "module", "default"],
      },
      optimization: {
        splitChunks: false,
        runtimeChunk: false,
      },
      output: {
        filename: "assets/[name].js",
        chunkFilename: "assets/[name].js",
        assetModuleFilename: "assets/[name][ext]",
      },
    },
  },
  output: {
    filenameHash: false,
    filename: {
      js: "assets/[name].js",
      css: "assets/[name].css",
      assets: "assets/[name][ext]",
      media: "assets/[name][ext]",
      image: "assets/[name][ext]",
      font: "assets/[name][ext]",
      svg: "assets/[name].svg",
    },
    sourceMap: {
      js: "cheap-module-source-map",
      css: true,
    },
  },
});
