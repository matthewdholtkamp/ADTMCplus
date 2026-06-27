import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  containsPossiblePhi,
  parseAskRequest,
  validateClinicalResult
} from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = "https://matthewdholtkamp.github.io";

const validPayload = {
  question: "A nonspecific adult has acute ankle pain. Which coded pathway applies?",
  history: [],
  pageContext: {
    activeTool: "landing-page",
    protocolId: "",
    selectedOptions: []
  },
  source: {
    repository: "matthewdholtkamp/ADTMCplus"
  },
  algorithmContext: {
    catalog: [{
      tool: "msk",
      id: "ankle",
      title: "Acute Ankle Pain",
      category: "Musculoskeletal Screening"
    }],
    candidates: [{
      tool: "msk",
      id: "ankle",
      title: "Acute Ankle Pain",
      category: "Musculoskeletal Screening",
      content: {
        nodes: {
          visit_type: {
            question: "Select the reason for today's encounter."
          }
        }
      }
    }]
  }
};

const validResult = {
  coverage: "matched",
  urgency: "routine",
  algorithmMatch: "MSK ankle: Acute Ankle Pain",
  whatCodeSays: ["Begin at the visit type question."],
  nextStep: "Open the ankle pathway and complete its coded questions.",
  limitation: "Use clinical judgment and make each pathway selection yourself.",
  sources: [{
    tool: "msk",
    protocolId: "ankle",
    location: "nodes.visit_type",
    label: "Acute Ankle Pain"
  }],
  navigation: {
    kind: "msk_protocol",
    protocolId: "ankle",
    label: "Open ankle pathway"
  }
};

function geminiResponse(result: unknown = validResult): Response {
  return Response.json({
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify(result) }]
      }
    }]
  });
}

async function callWorker(path: string, init?: RequestInit): Promise<Response> {
  const request = new IncomingRequest(`https://worker.test${path}`, init);
  const ctx = createExecutionContext();
  return worker.fetch(request, env, ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("privacy guard", () => {
  it("allows de-identified clinical facts", () => {
    expect(containsPossiblePhi("Adult, age 24, BP 120/80, ankle pain for two days.")).toBe(false);
  });

  it.each([
    "Call the patient at 573-555-1212",
    "DOB: 01/02/1999",
    "SGT Smith has knee pain",
    "MRN 12345678",
    "Email soldier@example.mil"
  ])("blocks likely identifying information: %s", (text) => {
    expect(containsPossiblePhi(text)).toBe(true);
  });
});

describe("request and result validation", () => {
  it("accepts a bounded code-grounded request", () => {
    expect(parseAskRequest(validPayload)).not.toBeNull();
  });

  it("rejects requests with too many candidates", () => {
    const invalid = structuredClone(validPayload);
    invalid.algorithmContext.candidates = Array.from({ length: 7 }, () =>
      structuredClone(validPayload.algorithmContext.candidates[0])
    );
    expect(parseAskRequest(invalid)).toBeNull();
  });

  it("rejects a matched result that cites an algorithm without expanded evidence", () => {
    const parsed = parseAskRequest({
      ...validPayload,
      algorithmContext: {
        catalog: [
          ...validPayload.algorithmContext.catalog,
          {
            tool: "adtmc",
            id: "A-1",
            title: "Sore Throat",
            category: "ENT"
          }
        ],
        candidates: validPayload.algorithmContext.candidates
      }
    });
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    const unsupportedCitation = structuredClone(validResult);
    unsupportedCitation.sources = [{
      tool: "adtmc",
      protocolId: "A-1",
      location: "steps.start",
      label: "Sore Throat"
    }];
    expect(validateClinicalResult(unsupportedCitation, parsed)).toBeNull();
  });

  it("removes clinical interpretation from closest-pathway output", () => {
    const parsed = parseAskRequest(validPayload);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    const closest = structuredClone(validResult);
    closest.coverage = "closest";
    closest.urgency = "routine";
    closest.whatCodeSays = ["This statement must be removed."];
    const validated = validateClinicalResult(closest, parsed);
    expect(validated?.whatCodeSays).toEqual([]);
    expect(validated?.urgency).toBe("unknown");
  });
});

describe("Worker API", () => {
  it("returns a public health response without exposing a secret", async () => {
    const response = await callWorker("/health");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body.status).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("test-gemini-key");
  });

  it("rejects POST requests from other origins", async () => {
    const response = await callWorker("/v1/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://example.com"
      },
      body: JSON.stringify(validPayload)
    });
    expect(response.status).toBe(403);
  });

  it("blocks possible PHI before calling Gemini", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    const response = await callWorker("/v1/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": ORIGIN
      },
      body: JSON.stringify({
        ...validPayload,
        question: "Patient phone is 573-555-1212 and ankle hurts."
      })
    });
    expect(response.status).toBe(422);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the fixed primary model and returns a validated result", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(geminiResponse());
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await callWorker("/v1/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": ORIGIN
      },
      body: JSON.stringify(validPayload)
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ model: string; result: typeof validResult }>();
    expect(body.model).toBe("gemini-3.1-flash-lite");
    expect(body.result.navigation.label).toBe("ankle: Acute Ankle Pain");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(String(upstream.mock.calls[0][0])).toContain("/gemini-3.1-flash-lite:generateContent");
    const init = upstream.mock.calls[0][1];
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-gemini-key" });
    expect(JSON.stringify(init?.body)).not.toContain("patient phone");
  });

  it("falls back to Gemini 3.5 Flash when the primary model fails", async () => {
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(geminiResponse());
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await callWorker("/v1/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": ORIGIN
      },
      body: JSON.stringify(validPayload)
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ model: string }>();
    expect(body.model).toBe("gemini-3.5-flash");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[1][0])).toContain("/gemini-3.5-flash:generateContent");
  });

  it("returns a safe outage response when both models fail", async () => {
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await callWorker("/v1/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": ORIGIN
      },
      body: JSON.stringify(validPayload)
    });

    expect(response.status).toBe(503);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("models_unavailable");
  });
});
