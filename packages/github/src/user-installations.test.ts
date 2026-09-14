import { describe, expect, it } from "vitest";
import { GitHubApiError } from "./errors";
import { listUserInstallations, nextPageUrl } from "./user-installations";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("listUserInstallations", () => {
  it("paginates GET /user/installations with the user's bearer token", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (!url.includes("page=2")) {
        return json(
          200,
          {
            total_count: 3,
            installations: [
              { id: 1, account: { login: "octocat", type: "User" } },
              { id: 2, account: null },
            ],
          },
          {
            link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next", <https://api.github.com/user/installations?per_page=100&page=2>; rel="last"',
          },
        );
      }
      return json(200, {
        total_count: 3,
        installations: [{ id: 3, account: { login: "octo-org", type: "Organization" } }],
      });
    }) as typeof globalThis.fetch;

    const installations = await listUserInstallations("gho_usertoken", { fetch });
    expect(installations).toEqual([
      { id: 1, accountLogin: "octocat", accountType: "User" },
      { id: 3, accountLogin: "octo-org", accountType: "Organization" },
    ]);
    expect(requests).toEqual([
      {
        url: "https://api.github.com/user/installations?per_page=100",
        authorization: "Bearer gho_usertoken",
      },
      {
        url: "https://api.github.com/user/installations?per_page=100&page=2",
        authorization: "Bearer gho_usertoken",
      },
    ]);
  });

  it("throws a coded error on a failed response without reading its body into the message", async () => {
    const fetch = (async () =>
      json(401, { message: "Bad credentials" })) as typeof globalThis.fetch;
    const error = await listUserInstallations("gho_expired", { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ code: "user_installations_failed", status: 401 });
    expect(String(error)).not.toContain("gho_expired");
  });

  it("refuses to follow pagination to another host", async () => {
    const fetch = (async () =>
      json(
        200,
        { installations: [] },
        { link: '<https://evil.example/steal>; rel="next"' },
      )) as typeof globalThis.fetch;
    await expect(listUserInstallations("gho_token", { fetch })).rejects.toMatchObject({
      code: "unexpected_pagination_url",
    });
  });

  it("rejects an empty token and malformed responses", async () => {
    await expect(listUserInstallations("")).rejects.toMatchObject({
      code: "missing_user_access_token",
    });
    const fetch = (async () => json(200, { nope: true })) as typeof globalThis.fetch;
    await expect(listUserInstallations("gho_token", { fetch })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });
});

describe("nextPageUrl", () => {
  it("extracts rel=next and ignores other relations", () => {
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(
      nextPageUrl(
        '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"',
      ),
    ).toBe("https://api.github.com/x?page=3");
  });
});
