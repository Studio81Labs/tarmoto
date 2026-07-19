declare module "react-native-keep-awake" {
  const KeepAwake: {
    activate(): void;
    deactivate(): void;
  };
  export default KeepAwake;
}

declare module "@env" {
  export const TARMOTO_API_URL: string | undefined;
  export const TARMOTO_MAP_STYLE_URL: string | undefined;
}
