import type { MappedConcept } from "./selection";

export interface MappingFixture {
  id: string;
  title: string;
  description: string;
  mappings: MappedConcept[];
}

/**
 * Hand-written stand-in for concept-mapper output until Milestone 3.
 * Mirrors the brief's example: a checkout change that adds retries around a
 * non-idempotent upstream payment call.
 */
export const paymentRetryFixture: MappingFixture = {
  id: "payment-retry",
  title: "Checkout Service — payment-retry",
  description:
    "Adds an authenticated charge endpoint that retries the upstream payments API with exponential backoff.",
  mappings: [
    {
      conceptId: "web.idempotency",
      relevance: 0.85,
      significance: 0.9,
      suggestedDepth: "advanced",
      evidence: [
        {
          path: "src/services/paymentService.ts",
          startLine: 41,
          endLine: 58,
          excerpt:
            "return withRetry(() => paymentsApi.post('/charges', payload), { attempts: 4 });",
          rationale:
            "A POST that creates a charge is retried; a timed-out attempt may already have created one.",
        },
      ],
    },
    {
      conceptId: "web.retries",
      relevance: 0.9,
      significance: 0.85,
      suggestedDepth: "applied",
      evidence: [
        {
          path: "src/lib/withRetry.ts",
          startLine: 1,
          endLine: 27,
          excerpt: "const delay = baseMs * 2 ** attempt;\nawait sleep(delay);",
          rationale:
            "New retry helper with exponential backoff but no jitter or retryable-error filter.",
        },
      ],
    },
    {
      conceptId: "reliability.timeouts",
      relevance: 0.6,
      significance: 0.5,
      suggestedDepth: "applied",
      evidence: [
        {
          path: "src/services/paymentService.ts",
          startLine: 12,
          excerpt: "const paymentsApi = createClient({ baseUrl: env.PAYMENTS_API_URL });",
          rationale: "The upstream client is created without a request timeout.",
        },
      ],
    },
    {
      conceptId: "fundamentals.error-handling",
      relevance: 0.7,
      significance: 0.45,
      suggestedDepth: "applied",
      evidence: [
        {
          path: "src/services/paymentService.ts",
          startLine: 60,
          endLine: 66,
          excerpt:
            "} catch (err) {\n  logger.warn('charge failed');\n  return { charged: false };\n}",
          rationale: "An upstream failure is reported to the caller as a definite 'not charged'.",
        },
      ],
    },
    {
      conceptId: "web.authn-vs-authz",
      relevance: 0.55,
      significance: 0.35,
      suggestedDepth: "applied",
      evidence: [
        {
          path: "src/app/api/orders/[orderId]/charge/route.ts",
          startLine: 8,
          endLine: 14,
          excerpt:
            "const session = await requireSession(req);\nconst order = await getOrder(params.orderId);",
          rationale:
            "The route authenticates the caller but loads the order by ID without an ownership check.",
        },
      ],
    },
    {
      conceptId: "web.serialization",
      relevance: 0.45,
      significance: 0.2,
      suggestedDepth: "intro",
      evidence: [
        {
          path: "src/app/api/orders/[orderId]/charge/route.ts",
          startLine: 20,
          excerpt: "return Response.json(result);",
          rationale: "The charge result is serialized directly to the client.",
        },
      ],
    },
  ],
};
