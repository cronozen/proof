import type { HttpClient } from '../client';
import type {
  RecordDecisionRequest,
  ApproveDecisionRequest,
  DecisionEventResponse,
  DecisionEventListResponse,
  ApprovalResponse,
  ListDecisionOptions,
  VerificationResponse,
  ChainVerificationOptions,
  ChainVerificationResponse,
} from '../types';

export class DecisionResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Record a new decision event.
   *
   * Creates a DRAFT evidence record linked to the proof hash chain.
   */
  async record(
    request: RecordDecisionRequest,
  ): Promise<DecisionEventResponse> {
    const response = await this.http.request<{ data: DecisionEventResponse }>(
      'POST',
      '/decision-events',
      { body: request },
    );
    return response.data;
  }

  /**
   * Approve or reject a decision event.
   *
   * If approved, the evidence is sealed with a SHA-256 chain hash
   * and the evidence level becomes AUDIT_READY.
   *
   * @throws ConflictError if the decision is already sealed.
   */
  async approve(
    id: string,
    request: ApproveDecisionRequest,
  ): Promise<ApprovalResponse> {
    const response = await this.http.request<{ data: ApprovalResponse }>(
      'POST',
      `/decision-events/${encodeURIComponent(id)}/approvals`,
      { body: request },
    );
    return response.data;
  }

  /**
   * Get a single decision event by ID or decisionId.
   */
  async get(id: string): Promise<DecisionEventResponse> {
    const response = await this.http.request<{ data: DecisionEventResponse }>(
      'GET',
      `/decision-events/${encodeURIComponent(id)}`,
    );
    return response.data;
  }

  /**
   * Verify a decision's proof — recomputes the hash chain from the stored record.
   *
   * This is **not** a status lookup. The server rebuilds the chain hash from the
   * record itself and compares it, checks the link to the preceding record,
   * re-derives the seal hash over the approval fields, and verifies the Ed25519
   * server signature. Any post-hoc edit to the record makes `verified` false.
   *
   * The endpoint is public (no auth required) — verification must never be gated.
   * Read `limitations` in the response: this proves internal consistency, not
   * third-party attestation (no RFC 3161 timestamp, no external anchor yet).
   *
   * @param id evidence id, decision id, or record id
   */
  async verify(id: string): Promise<VerificationResponse> {
    return this.http.request<VerificationResponse>(
      'GET',
      `/verify/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Verify an entire chain domain.
   *
   * Individual records can each be valid while the chain is still broken —
   * if a record in the middle was deleted, only a whole-chain scan sees the gap.
   * `firstBrokenIndex` and `missingIndexes` report exactly where.
   *
   * Requires authentication and is tenant-scoped: the response contains the
   * domain name and chain positions, which are customer operational data.
   */
  async verifyChain(
    domain: string,
    options?: ChainVerificationOptions,
  ): Promise<ChainVerificationResponse> {
    const response = await this.http.request<{ data: ChainVerificationResponse }>(
      'GET',
      `/decision-events/verify-chain/${encodeURIComponent(domain)}`,
      {
        query: {
          fromIndex: options?.fromIndex,
          toIndex: options?.toIndex,
          limit: options?.limit,
        },
      },
    );
    return response.data;
  }

  /**
   * List decision events with optional filters.
   */
  async list(
    options?: ListDecisionOptions,
  ): Promise<DecisionEventListResponse> {
    return this.http.request<DecisionEventListResponse>(
      'GET',
      '/decision-events',
      {
        query: {
          limit: options?.limit,
          offset: options?.offset,
          type: options?.type,
          status: options?.status,
          tag: options?.tag,
        },
      },
    );
  }
}
