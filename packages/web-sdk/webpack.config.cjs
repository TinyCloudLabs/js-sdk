
const path = require("path");
const webpack = require("webpack");

const isProduction = process.env.NODE_ENV === "production";

const rules = [
  {
    test: /\.tsx?$/,
    use: "ts-loader",
    exclude: /node_modules/,
  },
  {
    // Handle ES modules properly
    test: /\.m?js$/,
    resolve: {
      fullySpecified: false,
    },
  },
];

const plugins = [
  new webpack.ProvidePlugin({
    Buffer: ["buffer", "Buffer"],
    process: "process/browser",
  }),
  new webpack.DefinePlugin({
    global: "globalThis",
  }),
  // Handle node: scheme imports by removing the node: prefix
  new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
    resource.request = resource.request.replace(/^node:/, "");
  }),
  // Replace @noble/hashes/crypto import to use browser version
  new webpack.NormalModuleReplacementPlugin(
    /@noble\/hashes\/crypto$/,
    path.resolve(__dirname, "src/polyfills/noble-crypto-browser.mjs")
  ),
  {
    apply(compiler) {
      compiler.hooks.compilation.tap("NoReplica", (compilation) =>
        compilation.hooks.finishModules.tap("NoReplica", (modules) => {
          for (const module of modules) {
            if (/[\\/](packages[\\/]replica|@tinycloud[\\/]replica)[\\/]/.test(module.resource ?? "")) {
              compilation.errors.push(
                new compiler.webpack.WebpackError(`web-sdk must not bundle replica code: ${module.resource}`)
              );
            }
          }
        })
      );
    },
  },
];

const resolveConfig = {
  extensions: [".tsx", ".ts", ".js", ".mjs"],
  // Add conditionNames to properly resolve ES modules with browser support
  conditionNames: ["browser", "import", "require", "default"],
  // Enable browser field support
  mainFields: ["browser", "module", "main"],
  fallback: {
    // Existing polyfills
    util: require.resolve("util/"),
    path: require.resolve("path-browserify"),
    buffer: require.resolve("buffer/"),
    os: require.resolve("os-browserify/browser"),
    url: require.resolve("url/"),
    stream: require.resolve("stream-browserify"),
    https: require.resolve("https-browserify"),
    assert: require.resolve("assert/"),
    http: require.resolve("stream-http"),
    events: require.resolve("events/"),
    process: require.resolve("process/browser"),

    // Additional polyfills for missing modules
    crypto: require.resolve("crypto-browserify"),
    zlib: require.resolve("browserify-zlib"),
    vm: require.resolve("vm-browserify"),

    // These modules don't work in browsers, so we disable them
    fs: false,
    net: false,
    tls: false,
    child_process: false,

    // Handle node: scheme imports
    "node:crypto": false,  // Disable node:crypto entirely for browser
    "node:buffer": require.resolve("buffer/"),
    "node:util": require.resolve("util/"),
    "node:stream": require.resolve("stream-browserify"),
    "node:path": require.resolve("path-browserify"),
    "node:events": require.resolve("events/"),
    "node:url": require.resolve("url/"),
    "node:vm": require.resolve("vm-browserify"),
    "node:fs": false,
    "node:net": false,
    "node:tls": false,
    "node:os": require.resolve("os-browserify/browser"),
  },
};

// The links reader of `@tinycloud/share-envelope` is its own file, loaded by an `import()` when a share link is first
// resolved or published. It stays a package import (the bundle does not carry it), like the replica deferred imports
// below; `@tinycloud/share-envelope` is a dependency of this package.
const LINKS_REQUEST = "@tinycloud/share-envelope/links";
const linksExternal = ({ request }, callback) => {
  if (request === LINKS_REQUEST) {
    callback(null, `import ${request}`);
    return;
  }
  callback();
};

const baseConfig = {
  mode: isProduction ? "production" : "development",
  target: "web",
  entry: "./src/index.ts",
  devtool: isProduction ? false : 'source-map',
  module: { rules },
  resolve: resolveConfig,
  externals: [linksExternal],
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
    // Disable HMR and development optimizations in production
    ...(isProduction && {
      minimize: true,
    }),
  },
  plugins: [
    ...plugins,
    // Keep the package bundle self-contained for downstream bundlers like CRA.
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
  ],
  // Prevent webpack from injecting Node.js polyfills for global, __filename, __dirname
  node: false,
};

const esmConfig = {
  ...baseConfig,
  output: {
    filename: "index.mjs",
    path: path.resolve(__dirname, "dist"),
    globalObject: "globalThis",
    library: {
      type: "module",
    },
    module: true,
    environment: {
      module: true,
    },
  },
  experiments: {
    outputModule: true,
  },
};

const cjsConfig = {
  ...baseConfig,
  output: {
    filename: "index.cjs",
    path: path.resolve(__dirname, "dist"),
    globalObject: "globalThis",
    library: {
      type: "commonjs2",
    },
    // The deferred import of the links reader is a real `import()` in the CommonJS bundle too.
    environment: { dynamicImport: true },
  },
};

// Browser adapter and Node-only profile gate stay external and load on demand.
// The parser remains a package external so web-sdk never embeds replica source.
const replicaExternals = (moduleType) => ({ context, request }, callback) => {
  if (request === "./index" && context === path.resolve(__dirname, "src")) {
    callback(null, `${moduleType} @tinycloud/web-sdk`);
    return;
  }
  if (request === "./replica-gated" && context === path.resolve(__dirname, "src")) {
    callback(null, `${moduleType} @tinycloud/web-sdk/replica-gated`);
    return;
  }
  if (request === LINKS_REQUEST) {
    callback(null, `import ${request}`);
    return;
  }
  if (request && /^@tinycloud\/replica(?:\/|$)/.test(request)) {
    const deferred = request === "@tinycloud/replica/kv-storage" || request === "@tinycloud/replica/profile-gate";
    callback(null, `${deferred ? "import" : moduleType} ${request}`);
    return;
  }
  callback();
};

const replicaSharedPlugins = [
  new webpack.NormalModuleReplacementPlugin(
    /^@tinycloud\/sdk-core$/,
    path.resolve(__dirname, "src/replica-core-bridge.ts")
  ),
  new webpack.NormalModuleReplacementPlugin(
    /^@tinycloud\/sdk-services$/,
    path.resolve(__dirname, "src/replica-services-bridge.ts")
  ),
  new webpack.NormalModuleReplacementPlugin(
    /^siwe$/,
    path.resolve(__dirname, "src/replica-siwe-bridge.ts")
  ),
];

const replicaEsmConfig = {
  ...esmConfig,
  entry: "./src/replica.ts",
  externals: replicaExternals("module"),
  plugins: [...esmConfig.plugins, ...replicaSharedPlugins],
  output: { ...esmConfig.output, filename: "replica.mjs" },
};

const replicaCjsConfig = {
  ...cjsConfig,
  entry: "./src/replica.ts",
  externals: replicaExternals("commonjs"),
  plugins: [...cjsConfig.plugins, ...replicaSharedPlugins],
  output: {
    ...cjsConfig.output,
    filename: "replica.cjs",
    environment: { ...cjsConfig.output.environment, dynamicImport: true },
  },
};

const gatedEsmConfig = {
  ...replicaEsmConfig,
  entry: "./src/replica-gated.ts",
  output: { ...replicaEsmConfig.output, filename: "replica-gated.mjs" },
};
const gatedCjsConfig = {
  ...replicaCjsConfig,
  entry: "./src/replica-gated.ts",
  output: { ...replicaCjsConfig.output, filename: "replica-gated.cjs" },
};

// The lazy chunks are their own entries (contracts-ade §1.4 budget applies to the eager root only).
// The root loads each by relative sibling path, at first use, and never bundles it.
const LAZY_ENTRIES = [
  { request: "./panel-entry", dir: "src/ui", file: "panel" },
  { request: "./panel-data-entry", dir: "src/ui", file: "panel-data" },
  { request: "./modals-entry", dir: "src/notifications", file: "modals" },
];
const lazyLoaderExternals = (type, ext) => ({ context, request }, callback) => {
  const entry = LAZY_ENTRIES.find((e) => e.request === request && context === path.resolve(__dirname, e.dir));
  if (entry) {
    callback(null, `${type} ./${entry.file}.${ext}`);
    return;
  }
  callback();
};

// The panel code keeps @tinycloud/* external, like the replica entries. The dialogs do not: they import runtime
// constants from @tinycloud/sdk-core, and a bare import in a chunk loaded at the first prompt would not resolve for a
// page that loads the SDK without a bundler. So only imports made from src/ui are external.
const lazyExternals = (moduleType, ext) => ({ context, request }, callback) => {
  const uiDir = path.resolve(__dirname, "src/ui");
  if (request && /^@tinycloud\//.test(request) && context && context.startsWith(uiDir)) {
    callback(null, `${moduleType} ${request}`);
    return;
  }
  // The panel shares the eager root's panel-data singleton, so both loaders see one live source.
  if (request === "./panel-data-entry" && context === uiDir) {
    callback(null, `${moduleType} ./panel-data.${ext}`);
    return;
  }
  callback();
};

const rootEsmConfig = { ...esmConfig, externals: [linksExternal, lazyLoaderExternals("import", "mjs")] };
const rootCjsConfig = {
  ...cjsConfig,
  externals: [linksExternal, lazyLoaderExternals("commonjs", "cjs")],
  output: { ...cjsConfig.output, environment: { dynamicImport: true } },
};

// The lazy entries share one compilation per format: they share most of their module graph, and a compilation per
// entry runs the build out of memory at the default heap.
const lazyEntries = {
  panel: "./src/ui/panel-entry.ts",
  "panel-data": "./src/ui/panel-data-entry.ts",
  modals: "./src/notifications/modals-entry.ts",
};
const notChunkLimit = (plugin) => !(plugin instanceof webpack.optimize.LimitChunkCountPlugin);

const lazyEsmConfig = {
  ...esmConfig,
  entry: lazyEntries,
  externals: lazyExternals("module", "mjs"),
  plugins: esmConfig.plugins.filter(notChunkLimit),
  output: { ...esmConfig.output, filename: "[name].mjs" },
};

const lazyCjsConfig = {
  ...cjsConfig,
  entry: lazyEntries,
  externals: lazyExternals("commonjs", "cjs"),
  plugins: cjsConfig.plugins.filter(notChunkLimit),
  output: { ...cjsConfig.output, filename: "[name].cjs" },
};

// Headless subpath (`@tinycloud/web-sdk/credentials`). Built from the base
// configs only: no replica externals or plugins, so index/replica are unchanged.
const credentialsEsmConfig = {
  ...esmConfig,
  entry: "./src/credentials-subpath.ts",
  output: { ...esmConfig.output, filename: "credentials.mjs" },
};
const credentialsCjsConfig = {
  ...cjsConfig,
  entry: "./src/credentials-subpath.ts",
  output: { ...cjsConfig.output, filename: "credentials.cjs" },
};

module.exports = [
  rootEsmConfig,
  rootCjsConfig,
  replicaEsmConfig,
  replicaCjsConfig,
  gatedEsmConfig,
  gatedCjsConfig,
  lazyEsmConfig,
  lazyCjsConfig,
  credentialsEsmConfig,
  credentialsCjsConfig,
];
