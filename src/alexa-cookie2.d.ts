declare module "alexa-cookie2" {
  interface AlexaCookie {
    generateAlexaCookie(
      opts: unknown,
      cb: (err: Error | null, result: { refreshToken?: string }) => void
    ): void;
    stopProxyServer?(cb?: () => void): void;
  }
  const alexaCookie: AlexaCookie;
  export default alexaCookie;
}
