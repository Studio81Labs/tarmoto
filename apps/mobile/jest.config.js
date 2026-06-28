/** Jest config for the Tarmoto React Native mobile app. */
module.exports = {
  preset: "@react-native/jest-preset",
  setupFiles: ["<rootDir>/jest.setup.js"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  testMatch: [
    "**/__tests__/**/*.test.[jt]s?(x)",
    "**/?(*.)+(spec|test).[jt]s?(x)",
  ],
  transformIgnorePatterns: [
    "node_modules/(?!(?:\\.pnpm/)?((jest-)?@react-native|react-native|@testing-library|react-native-.*)[/+@])",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};
