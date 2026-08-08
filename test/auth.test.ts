import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticate } from "../src/auth.js";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const { fetch } = await import("undici");

describe("auth", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("exchanges token for cookies and fetches CSRF", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: {
            tokens: {
              cookies: {
                ".amazon.co.uk": [
                  { Name: "session-id", Value: "sid-1" },
                  { Name: "ubid-acbuk", Value: "ubid-1" },
                  { Name: "session-token", Value: "st-1" },
                  { Name: "x-acbuk", Value: '"xval"' },
                  { Name: "at-acbuk", Value: '"atval"' },
                  { Name: "sess-at-acbuk", Value: '"sessval"' },
                ],
              },
            },
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "set-cookie": "csrf=abc123; Path=/" }),
      } as unknown as Response);

    const creds = await authenticate({
      refreshToken: "Atnr|test",
      domain: "amazon.co.uk",
    });

    expect(creds.cookies).toContain("session-id=sid-1");
    expect(creds.cookies).toContain("csrf=abc123");
    expect(creds.csrf).toBe("abc123");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws on token exchange failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as unknown as Response);

    await expect(
      authenticate({ refreshToken: "bad", domain: "amazon.co.uk" })
    ).rejects.toThrow("Token exchange failed");
  });
});
