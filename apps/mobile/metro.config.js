const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const defaultConfig = getDefaultConfig(projectRoot);

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(monorepoRoot, "node_modules"),
    ],
    // Treat `.tflite` files as bundled assets so `require('./foo.tflite')`
    // returns an asset registry id (consumed by react-native-fast-tflite).
    assetExts: [...(defaultConfig.resolver?.assetExts ?? []), "tflite"],
  },
};

module.exports = mergeConfig(defaultConfig, config);
