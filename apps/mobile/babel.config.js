module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    [
      "module:react-native-dotenv",
      {
        moduleName: "@env",
        path: ".env",
        allowUndefined: true,
      },
    ],
    [
      "module-resolver",
      {
        root: ["./"],
        alias: {
          "@": "./src",
        },
      },
    ],
    // Reanimated's worklet transform must remain the final plugin.
    "react-native-reanimated/plugin",
  ],
};
