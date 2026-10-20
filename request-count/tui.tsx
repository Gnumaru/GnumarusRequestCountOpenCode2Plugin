import { Plugin } from "@opencode/plugin/tui"
import { RequestCount, type RequestCountStats } from "./rpc"

type Counters = RequestCountStats["history"]

const isEmpty = (counters: Counters) =>
  counters.total === 0 && counters.success === 0 && counters.error === 0 && counters.user === 0

/**
 * O TUI pode carregar o plugin mais de uma vez (uma instância por location).
 * Só a primeira registra slots e comandos, para não duplicar o rodapé.
 */
const ACTIVE_KEY = "__opencode_request_count_tui_active__"

export default Plugin.define({
  id: "request-count-tui",

  async setup(context) {
    const globals = globalThis as any
    if (globals[ACTIVE_KEY]) return
    globals[ACTIVE_KEY] = true

    const rpc = context.client.rpc(RequestCount)

    // A RPC é registrada por location: as chamadas precisam do diretório da
    // sessão para chegarem na instância do plugin que contou as requisições.
    const location = () => {
      const ref = context.location ?? context.data.location.default()
      return { directory: ref.directory }
    }

    const [state, setState] = context.storage.memory("request-count", {
      initial: { sessions: {} as Record<string, RequestCountStats> },
    })

    const store = (sessionID: string, stats: RequestCountStats) => {
      setState((draft) => {
        draft.sessions[sessionID] = stats
      })
    }

    const refresh = async (sessionID: string) => {
      if (!sessionID) return
      try {
        const stats = (await rpc.stats({ sessionID }, { location: location() })) as RequestCountStats
        store(sessionID, stats)
      } catch (error) {
        console.error("[request-count] não foi possível consultar os contadores:", error)
      }
    }

    // O servidor avisa quando os contadores mudam.
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = rpc.events.on("updated", (event) => {
        const payload = event as any
        const sessionID = payload?.data?.sessionID as string | undefined
        const directory = payload?.location?.directory as string | undefined
        const current = location().directory
        if (directory && directory !== current) return
        if (sessionID) void refresh(sessionID)
      })
    } catch (error) {
      console.error("[request-count] não foi possível assinar os eventos do servidor:", error)
    }

    // Rede de segurança: reconcilia de tempos em tempos.
    const timer = setInterval(() => {
      seedLast()
      for (const sessionID of Object.keys(state.sessions)) void refresh(sessionID)
    }, 5000)

    // Sessão "atual": a que está aberta no TUI, ou a última conhecida.
    let lastSession = ""
    const currentSession = () => {
      const route = context.ui.router.current()
      if (route.type === "session") return route.sessionID
      return lastSession
    }

    const track = (sessionID?: string) => {
      if (!sessionID || lastSession === sessionID) return
      lastSession = sessionID
      void refresh(sessionID)
    }

    // Na tela inicial não há sessão aberta: usa a mais recente como referência.
    const seedLast = () => {
      const sessions = context.data.session.list()
      if (sessions.length === 0) return
      const latest = [...sessions].sort(
        (left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0),
      )[0]
      if (latest?.id) track(latest.id)
    }

    seedLast()

    context.data.listen((envelope: any) => {
      const details = envelope?.details ?? envelope
      const data = details?.data ?? details
      const sessionID =
        data?.sessionID ?? data?.sessionId ?? data?.info?.sessionID ?? data?.properties?.sessionID
      if (typeof sessionID === "string") track(sessionID)
    })

    const details = (stats: RequestCountStats | undefined) => {
      if (!stats) return "Sem contadores disponíveis para esta sessão."
      const line = (label: string, counters: Counters) =>
        `  ${label.padEnd(12)} req ${counters.total} · ok ${counters.success} · err ${counters.error} · msg ${counters.user}`
      return [
        `Sessão ${stats.sessionID}`,
        "",
        line("absoluto", {
          total: stats.total,
          success: stats.success,
          error: stats.error,
          user: stats.user,
          modelCalls: stats.modelCalls,
        }),
        line("execução atual", stats.run),
        line("histórico", stats.history),
        "",
        `chamadas de modelo: ${stats.modelCalls}`,
      ].join("\n")
    }

    const colors = {
      base: context.theme.text.base,
    }

    const Footer = (props: { sessionID?: string }) => {
      // A leitura do store precisa acontecer dentro de uma expressão JSX:
      // é lá que o Solid cria o efeito que reage às mudanças dos contadores.
      const counters = () => {
        const sessionID = props.sessionID ?? currentSession()
        return sessionID ? state.sessions[sessionID] : undefined
      }
      const summary = () => {
        const stats = counters()
        if (!stats || isEmpty(stats)) return ""
        const history = stats.history.total
        const errors = stats.error > 0 ? ` · err ${stats.error}` : ""
        return `req ${stats.total}${history > 0 ? ` (${stats.run.total}+${history})` : ""} · ok ${stats.success}${errors} · msg ${stats.user}`
      }
      return <text fg={colors.base}>{summary}</text>
    }

    const unclaimPrompt = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        track(input.sessionID)
        return <Footer sessionID={input.sessionID} />
      },
    })

    const unclaimHome = context.ui.slot({
      append: "home.footer.status",
      render: () => <Footer sessionID={currentSession()} />,
    })

    context.keymap.layer(() => ({
      mode: "global" as const,
      priority: 10,
      commands: [
        {
          id: "request-count.show",
          title: "Request count: show counters",
          group: "Request count",
          palette: true,
          slash: { name: "request-count" },
          enabled: () => true,
          run: async () => {
            const sessionID = currentSession()
            if (sessionID) await refresh(sessionID)
            await context.ui.dialog.alert({
              title: "Request count",
              message: details(sessionID ? state.sessions[sessionID] : undefined),
            })
          },
        },
        {
          id: "request-count.reset",
          title: "Request count: reset counters",
          group: "Request count",
          palette: true,
          slash: { name: "request-count-reset" },
          enabled: () => true,
          run: async () => {
            const sessionID = currentSession()
            if (!sessionID) {
              context.ui.toast.show({
                title: "Request count",
                message: "Nenhuma sessão ativa.",
                variant: "info",
              })
              return
            }
            const confirmed = await context.ui.dialog.confirm({
              title: "Request count",
              message: `Zerar os contadores da sessão ${sessionID}?`,
              label: { confirm: "Zerar", cancel: "Cancelar" },
            })
            if (!confirmed) return
            try {
              await rpc.reset({ sessionID }, { location: location() })
              await refresh(sessionID)
              context.ui.toast.show({
                title: "Request count",
                message: "Contadores zerados.",
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                title: "Request count",
                message: `Falha ao zerar: ${String(error)}`,
                variant: "error",
              })
            }
          },
        },
      ],
      bindings: [],
    }))

    return () => {
      clearInterval(timer)
      unsubscribe?.()
      unclaimPrompt()
      unclaimHome()
      delete globals[ACTIVE_KEY]
    }
  },
})
