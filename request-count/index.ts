import { Plugin } from "@opencode/plugin"
import { RequestCount, type RequestCountCounters, type RequestCountStats } from "./rpc"

/**
 * Plugin de servidor: conta as requisições feitas ao servidor de LLM.
 *
 * O que é contado:
 *  - `user`       -> mensagens digitadas pelo usuário (hook `prompt`).
 *  - `total`      -> requisições HTTP feitas ao provedor de LLM. Inclui as
 *                    requisições "transparentes" do harness (geração de título,
 *                    compactação, continuações após tool calls, retries).
 *  - `success`    -> requisições que voltaram com resposta OK (status < 400).
 *  - `error`      -> requisições que falharam (status >= 400, erro de rede ou
 *                    erro no meio do stream).
 *
 * Cada contador é separado em:
 *  - `history` -> acumulado de execuções anteriores do servidor (sessão retomada).
 *  - `run`     -> acumulado do processo atual do servidor.
 */

const STORAGE_PREFIX = "counters"

type Counters = RequestCountCounters

const ZERO: Counters = { total: 0, success: 0, error: 0, user: 0, modelCalls: 0 }

const zero = (): Counters => ({ ...ZERO })

const merge = (a: Counters, b: Counters): Counters => ({
  total: a.total + b.total,
  success: a.success + b.success,
  error: a.error + b.error,
  user: a.user + b.user,
  modelCalls: a.modelCalls + b.modelCalls,
})

/** Contadores de uma sessão, como ficam guardados no disco. */
type Stored = {
  /** Acumulado de execuções anteriores do servidor. */
  history: Counters
  /** Acumulado do processo do servidor em que `processStartedAt` foi gravado. */
  run: Counters
  /** Instante de início do processo que produziu os contadores de `run`. */
  processStartedAt: number
  updatedAt: number
}

type Persisted = {
  version: number
  sessions: Record<string, Stored>
}

/** Contadores de uma sessão durante a execução atual. */
type Runtime = Stored & {
  /** Requisições disparadas mas sem resposta ainda. */
  inflight: number
  /** Resultado da última requisição resolvida. */
  lastOutcome?: "success" | "error"
  /** A sessão já usou transporte HTTP (para não duplicar com WebSocket). */
  seenHttp: boolean
}

/**
 * Instante de início do processo do servidor.
 *
 * Fica em `globalThis` porque o OpenCode carrega o plugin uma vez por
 * location, e cada carregamento é um módulo diferente: sem isso, cada
 * instância calcularia um instante levemente diferente e o histórico seria
 * zerado sem necessidade.
 */
const PROCESS_KEY = "__opencode_request_count_process_started_at__"
const PROCESS_STARTED_AT: number = ((globalThis as any)[PROCESS_KEY] ??= Math.round(Date.now() - process.uptime() * 1000))

const MAX_SESSIONS = 200
const MAX_SEEN_MESSAGES = 5000

/**
 * Estado de uma instância do plugin.
 *
 * O OpenCode registra os hooks de sessão por location, então cada instância
 * registra os seus (uma requisição nunca é contada duas vezes). O que é
 * compartilhado entre instâncias é o disco, e cada instância cuida das
 * próprias sessões.
 */
type Instance = {
  sessions: Map<string, Runtime>
  /** Sessões salvas no disco, usadas como ponto de partida. */
  baseline: Map<string, Stored>
  touched: Set<string>
  seenMessages: Set<string>
  seenOrder: string[]
  storage: Plugin.Context["storage"]
  /** Chave do armazenamento: uma por location/projeto. */
  storageKey: string
  emit: (sessionID: string) => Promise<void>
  persistTimer?: ReturnType<typeof setTimeout>
  emitTimer?: ReturnType<typeof setTimeout>
  pendingEmit: Set<string>
}

// ----------------------------------------------------------------------
// Contadores
// ----------------------------------------------------------------------

const parsePersisted = (raw: unknown): Persisted => {
  if (!raw || typeof raw !== "object") return { version: 1, sessions: {} }
  const value = raw as Partial<Persisted>
  const sessions: Record<string, Stored> = {}
  for (const [sessionID, entry] of Object.entries(value.sessions ?? {})) {
    if (!entry || typeof entry !== "object") continue
    sessions[sessionID] = {
      history: entry.history ?? zero(),
      run: entry.run ?? zero(),
      processStartedAt: entry.processStartedAt ?? 0,
      updatedAt: entry.updatedAt ?? 0,
    }
  }
  return { version: 1, sessions }
}

/**
 * Pega (ou cria) os contadores de uma sessão.
 *
 * Se os contadores de `run` foram feitos por outro processo do servidor
 * (por exemplo: a máquina reiniciou e a sessão foi retomada), eles passam
 * para o histórico e `run` começa do zero.
 */
const countersOf = (instance: Instance, sessionID: string): { history: Counters; run: Counters } => {
  const runtime = instance.sessions.get(sessionID)
  if (runtime) return { history: runtime.history, run: runtime.run }

  const stored = instance.baseline.get(sessionID)
  if (!stored) return { history: zero(), run: zero() }
  if (stored.processStartedAt === PROCESS_STARTED_AT) return { history: stored.history, run: stored.run }
  return { history: merge(stored.history, stored.run), run: zero() }
}

const ensure = (instance: Instance, sessionID: string): Runtime => {
  const existing = instance.sessions.get(sessionID)
  if (existing) return existing

  const stored = instance.baseline.get(sessionID)
  const sameProcess = stored?.processStartedAt === PROCESS_STARTED_AT
  const runtime: Runtime = {
    history: stored ? (sameProcess ? stored.history : merge(stored.history, stored.run)) : zero(),
    run: stored && sameProcess ? stored.run : zero(),
    processStartedAt: PROCESS_STARTED_AT,
    updatedAt: stored?.updatedAt ?? 0,
    inflight: 0,
    lastOutcome: undefined,
    seenHttp: false,
  }
  instance.sessions.set(sessionID, runtime)
  instance.touched.add(sessionID)
  return runtime
}

const statsOf = (instance: Instance, sessionID: string): RequestCountStats => {
  const { history, run } = countersOf(instance, sessionID)
  const total = merge(history, run)
  return {
    sessionID,
    total: total.total,
    success: total.success,
    error: total.error,
    user: total.user,
    modelCalls: total.modelCalls,
    history: { ...history },
    run: { ...run },
  }
}

const bump = (instance: Instance, runtime: Runtime, key: keyof Counters, amount = 1) => {
  runtime.run[key] += amount
  runtime.updatedAt = Date.now()
  schedulePersist(instance)
}

// ----------------------------------------------------------------------
// Persistência
// ----------------------------------------------------------------------

const persist = async (instance: Instance) => {
  instance.persistTimer = undefined
  try {
    // O armazenamento é por projeto, mas várias instâncias (locations)
    // podem gravar nele: só as sessões tocadas por esta instância são
    // gravadas, para não sobrescrever as outras.
    const current = parsePersisted(await instance.storage.get(instance.storageKey))
    for (const sessionID of instance.touched) {
      const runtime = instance.sessions.get(sessionID)
      if (!runtime) continue
      current.sessions[sessionID] = {
        history: runtime.history,
        run: runtime.run,
        processStartedAt: PROCESS_STARTED_AT,
        updatedAt: runtime.updatedAt,
      }
    }
    const sessions = Object.fromEntries(
      Object.entries(current.sessions)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, MAX_SESSIONS),
    )
    await instance.storage.set(instance.storageKey, { version: 1, sessions })
  } catch {
    // armazenamento indisponível: manter contagem apenas em memória
  }
}

const schedulePersist = (instance: Instance) => {
  if (instance.persistTimer) return
  instance.persistTimer = setTimeout(() => {
    void persist(instance)
  }, 500)
}

// ----------------------------------------------------------------------
// Eventos para o TUI
// ----------------------------------------------------------------------

const scheduleEmit = (instance: Instance, sessionID: string) => {
  instance.pendingEmit.add(sessionID)
  if (instance.emitTimer) return
  instance.emitTimer = setTimeout(() => {
    instance.emitTimer = undefined
    const ids = [...instance.pendingEmit]
    instance.pendingEmit.clear()
    for (const id of ids) void instance.emit(id)
  }, 80)
}

// ----------------------------------------------------------------------
// Plugin
// ----------------------------------------------------------------------

export default Plugin.define({
  id: "request-count",
  async setup(ctx) {
    const instance: Instance = {
      sessions: new Map(),
      touched: new Set(),
      seenMessages: new Set(),
      seenOrder: [],
      storage: ctx.storage,
      storageKey: `${STORAGE_PREFIX}:${ctx.location.project?.id ?? ctx.location.directory}`,
      emit: async () => {},
      pendingEmit: new Set(),
      baseline: new Map(),
    }

    // Carrega o que já foi salvo para as sessões conhecidas.
    try {
      const persisted = parsePersisted(await ctx.storage.get(instance.storageKey))
      instance.baseline = new Map(Object.entries(persisted.sessions))
    } catch {
      // sem histórico: tudo começa do zero
    }

    // ----------------------------------------------------------------
    // RPC (contadores + eventos para o TUI)
    // ----------------------------------------------------------------

    let registration: { dispose: () => Promise<void> } | undefined
    try {
      registration = await ctx.rpc.register(RequestCount, {
        stats: async (input) => {
          const { sessionID } = input as { sessionID: string }
          return statsOf(instance, sessionID)
        },
        reset: async (input) => {
          const { sessionID } = input as { sessionID: string }
          const runtime = ensure(instance, sessionID)
          runtime.history = zero()
          runtime.run = zero()
          runtime.inflight = 0
          runtime.lastOutcome = undefined
          runtime.updatedAt = Date.now()
          schedulePersist(instance)
          void persist(instance)
          scheduleEmit(instance, sessionID)
          return { ok: true }
        },
      })
      instance.emit = async (sessionID: string) => {
        try {
          await registration.events.emit("updated", { sessionID })
        } catch {
          // sem emissor: o TUI ainda consulta por polling
        }
      }
    } catch (error) {
      console.error("[request-count] falha ao registrar RPC:", error)
    }

    // ----------------------------------------------------------------
    // Hooks de sessão
    // ----------------------------------------------------------------

    const disposers: Array<{ dispose: () => Promise<void> }> = []
    const hook = async (name: any, callback: (event: any) => void | Promise<void>) => {
      try {
        disposers.push(await ctx.session.hook(name, callback))
      } catch (error) {
        console.error(`[request-count] hook "${name}" indisponível:`, error)
      }
    }

    // Mensagens digitadas pelo usuário.
    await hook("prompt", (event) => {
      const messageID = event.messageID as string | undefined
      if (messageID) {
        if (instance.seenMessages.has(messageID)) return
        instance.seenMessages.add(messageID)
        instance.seenOrder.push(messageID)
        while (instance.seenOrder.length > MAX_SEEN_MESSAGES) {
          const old = instance.seenOrder.shift()
          if (old) instance.seenMessages.delete(old)
        }
      }
      const runtime = ensure(instance, event.sessionID as string)
      bump(instance, runtime, "user")
      scheduleEmit(instance, event.sessionID as string)
    })

    // Chamadas de modelo (uma por tentativa de chamada ao LLM).
    await hook("model.request", (event) => {
      const runtime = ensure(instance, event.sessionID as string)
      bump(instance, runtime, "modelCalls")
      scheduleEmit(instance, event.sessionID as string)
    })

    // Requisição HTTP disparada ao provedor de LLM.
    await hook("http.request", (event) => {
      const runtime = ensure(instance, event.sessionID as string)
      runtime.seenHttp = true
      runtime.inflight += 1
      bump(instance, runtime, "total")
      scheduleEmit(instance, event.sessionID as string)
    })

    // Resposta HTTP do provedor de LLM.
    await hook("http.response", (event) => {
      const runtime = ensure(instance, event.sessionID as string)
      if (runtime.inflight > 0) runtime.inflight -= 1
      const failed = event.response.status >= 400
      runtime.lastOutcome = failed ? "error" : "success"
      bump(instance, runtime, failed ? "error" : "success")
      scheduleEmit(instance, event.sessionID as string)
    })

    // Falha do provedor: erro de rede, status >= 400 ou stream quebrado.
    await hook("retry", (event) => {
      const runtime = ensure(instance, event.sessionID as string)
      if (runtime.inflight > 0) {
        // A requisição falhou antes de qualquer resposta.
        runtime.inflight -= 1
        runtime.lastOutcome = "error"
        bump(instance, runtime, "error")
      } else if (runtime.lastOutcome === "success") {
        // A resposta chegou (2xx) mas o stream falhou depois: conta como erro.
        runtime.lastOutcome = "error"
        runtime.run.success -= 1
        bump(instance, runtime, "error")
      } else if (runtime.lastOutcome === undefined) {
        // Falha antes de qualquer requisição observada.
        runtime.lastOutcome = "error"
        bump(instance, runtime, "error")
      }
      scheduleEmit(instance, event.sessionID as string)
    })

    // Provedores que usam WebSocket não passam pelo hook de HTTP. (Com os
    // hooks de HTTP registrados o OpenCode mantém o transporte HTTP, então
    // isso é apenas uma rede de segurança.)
    await hook("experimental.ws.handshake", (event) => {
      const runtime = ensure(instance, event.sessionID as string)
      if (runtime.seenHttp) return
      bump(instance, runtime, "total")
      scheduleEmit(instance, event.sessionID as string)
    })

    return async () => {
      if (instance.persistTimer) clearTimeout(instance.persistTimer)
      if (instance.emitTimer) clearTimeout(instance.emitTimer)
      await persist(instance)
      for (const disposer of disposers) {
        await disposer.dispose().catch(() => {})
      }
      await registration?.dispose().catch(() => {})
    }
  },
})
