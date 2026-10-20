import { Rpc } from "@opencode/plugin/rpc"

/**
 * Contadores de requisições de LLM mantidos pelo plugin de servidor.
 *
 * `history` = requisições feitas em execuções anteriores do servidor (ex.: a
 * sessão foi retomada depois de reiniciar a máquina).
 * `run`     = requisições feitas desde o início do processo atual do servidor.
 * Os totais (`total`, `success`, `error`, `user`) são a soma dos dois.
 */
const countersSchema = {
  type: "object",
  properties: {
    total: { type: "number" },
    success: { type: "number" },
    error: { type: "number" },
    user: { type: "number" },
    modelCalls: { type: "number" },
  },
  required: ["total", "success", "error", "user", "modelCalls"],
  additionalProperties: false,
} as const

export const RequestCount = Rpc.define({
  id: "request-count",
  methods: {
    /** Contadores da sessão informada. */
    stats: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          total: { type: "number" },
          success: { type: "number" },
          error: { type: "number" },
          user: { type: "number" },
          modelCalls: { type: "number" },
          history: countersSchema,
          run: countersSchema,
        },
        required: [
          "sessionID",
          "total",
          "success",
          "error",
          "user",
          "modelCalls",
          "history",
          "run",
        ],
        additionalProperties: false,
      },
    },
    /** Zera os contadores da sessão informada. */
    reset: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** Emitido sempre que os contadores de uma sessão mudam. */
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})

export type RequestCountCounters = {
  total: number
  success: number
  error: number
  user: number
  modelCalls: number
}

export type RequestCountStats = RequestCountCounters & {
  sessionID: string
  history: RequestCountCounters
  run: RequestCountCounters
}
