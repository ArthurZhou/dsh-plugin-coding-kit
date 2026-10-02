/**
 * The browser half: a settings section that edits the cheap lane.
 *
 * WHY THIS FILE IS HAND-WRITTEN AND NOT A BUILD ARTIFACT. Every other client
 * package in this harness is a tsdown bundle wrapped in
 * `window.__ModuleLoader__.load(...)`; a plugin repository with no toolchain
 * cannot produce one honestly, and a checked-in bundle nobody can rebuild is a
 * liability. So this is the same registration, written out, using
 * `React.createElement` where a bundle would use JSX. What it gives up is
 * brevity; what it keeps is that a reader can check the shipped file against
 * the source of every behaviour it has.
 *
 * WHAT IT EDITS. One settings namespace, `cheap-lane`, over the stock wire:
 * `settings.describe()` to read, `settings.mutate()` to write, and the pushed
 * `settings/document-updated` to stay fresh. No custom transport, no second
 * server, no port of its own — it is a section inside the harness's own settings
 * page, which is also why it works on any origin the app itself can reach.
 *
 * WHY IT NEVER OFFERS A TOOL NAME. The persona text and the cheap-batch skill
 * both name `subagent_cheap` in prose, so renaming the tool from a settings page
 * would leave the prompt routing to a tool that does not exist. The namespace
 * does not carry the name, and this page does not offer it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-coding-kit',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var h = React.createElement

    /** The namespace this page owns; must match the host row's registration. */
    var NAMESPACE = 'cheap-lane'
    var LOCALE_NS = 'cheap-lane'
    var CSS_ID = 'dsh-plugin-coding-kit/cheap-lane.css'
    /** Tools this page offers. The namespace schema accepts any string list. */
    var TOOLS = [
      { name: 'read' },
      { name: 'glob' },
      { name: 'grep' },
      { name: 'bash' },
      { name: 'write', risky: true },
      { name: 'edit', risky: true },
    ]

    var en = {
      nav: 'Cheap lane',
      title: 'Cheap lane',
      intro: 'The model this coding agent hands mechanical, repeatable work to, and the tools its child may use. Changes reach new sessions; a session that is already running keeps the tools it started with.',
      provider: 'Provider',
      model: 'Model',
      maxTokens: 'Output token cap',
      tools: 'Child tool allow-list',
      toolsHint: 'Look and compute, do not decide and do not write. A cheap child that can write your tree is a bulk revert waiting to happen.',
      loading: 'Loading…',
      apply: 'Apply',
      applying: 'Applying…',
      cancel: 'Cancel',
      saved: 'Applied — new sessions will use it.',
      failed: 'Could not apply',
      loadFailed: 'Could not read settings',
      retry: 'Retry',
      readOnly: 'The settings document is read-only in this deployment.',
      unconfigured: 'No models are configured, so the model list is empty. Add one on the Models page first.',
      riskWarning: 'This child may modify files, and everything it writes lands unreviewed.',
      current: 'In effect for new sessions',
      none: 'not set',
      sameAsSession: 'This is the session default model too, so the lane changes latency and isolation but saves nothing.',
    }
    var zh = {
      nav: '廉价道',
      title: '廉价道',
      intro: '这个编码 Agent 把机械、重复的活交给哪个模型，以及它的子代理能用哪些工具。改动对新会话生效；已在运行的会话保持启动时的工具集。',
      provider: '提供方',
      model: '模型',
      maxTokens: '输出 token 上限',
      tools: '子代理工具白名单',
      toolsHint: '只看不写、不做决策。让便宜模型改你的源码树，等于埋下一次大范围回滚。',
      loading: '加载中…',
      apply: '应用',
      applying: '应用中…',
      cancel: '取消',
      saved: '已应用，新会话生效。',
      failed: '应用失败',
      loadFailed: '无法读取配置',
      retry: '重试',
      readOnly: '此部署中配置文件为只读。',
      unconfigured: '还没有配置任何模型，模型列表是空的。请先在 Models 页添加。',
      riskWarning: '这个子代理可以修改文件，它写下的内容都没有复核。',
      current: '对新会话生效的配置',
      none: '未设置',
      sameAsSession: '这与会话默认模型相同，所以这条道只改变延迟和隔离，不省钱。',
    }

    var css = [
      '.dshl_section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}',
      '.dshl_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dshl_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}',
      '.dshl_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}',
      '.dshl_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}',
      '.dshl_ok{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}',
      '.dshl_warn{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}',
      '.dshl_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}',
      '.dshl_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}',
      '.dshl_field{display:flex;flex-direction:column;gap:6px}',
      '.dshl_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}',
      '.dshl_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}',
      'select.dshl_input{cursor:pointer}',
      '.dshl_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dshl_input:disabled{opacity:.6;cursor:default}',
      '.dshl_fieldset{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;margin:0;display:flex;flex-direction:column;gap:8px}',
      '.dshl_fieldset legend{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;padding:0 4px}',
      '.dshl_checks{display:flex;flex-wrap:wrap;gap:12px}',
      '.dshl_check{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dshl_risk{color:var(--dsw-alias-state-warn-label)}',
      '.dshl_actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dshl_button{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border-radius:16px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dshl_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}',
      '.dshl_secondary{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}',
      '.dshl_secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshl_button:disabled{opacity:.4;cursor:default}',
    ].join('')

    /** The tools whose inclusion this page refuses to treat as routine. */
    function riskyTools(allow) {
      return (allow || []).filter(function (tool) { return tool === 'write' || tool === 'edit' })
    }

    /** Path read at a chain of keys; undefined when any segment is missing. */
    function getPath(root, path) {
      var node = root
      for (var i = 0; i < (path || []).length; i++) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[path[i]]
      }
      return node
    }

    /**
     * Every configured provider/model pair, so the model picker can never hold
     * an id the provider does not serve. Ids are interpreted by the provider that
     * owns them, which is why the picker is a list and not a text field.
     */
    function optionsFrom(directory, view) {
      var options = []
      for (var i = 0; i < (directory || []).length; i++) {
        var entry = directory[i]
        var profile = getPath(view && view.value, entry.settingsPath || [])
        var models = (profile && profile.models) || []
        for (var m = 0; m < models.length; m++) {
          options.push({ provider: entry.provider, id: models[m].id })
        }
      }
      return options
    }

    /**
     * Persist the four fields the namespace carries.
     *
     * Path ops rather than a wholesale replace, so a namespace that later grows
     * a status field does not lose it on the next save from this page.
     */
    function save(api, value) {
      return api.settings.mutate({
        ns: NAMESPACE,
        ops: [
          { op: 'set', path: ['modelProvider'], value: value.modelProvider },
          { op: 'set', path: ['model'], value: value.model },
          { op: 'set', path: ['maxTokens'], value: value.maxTokens },
          { op: 'set', path: ['allow'], value: value.allow },
        ],
      }).then(function (response) {
        if (!response.result.ok) throw new Error(response.result.error.message)
        return response
      })
    }

    /** Smallest possible store: one page, one snapshot, no shared cache. */
    function createStore() {
      var state = { status: 'idle', value: {}, options: [], readOnly: false }
      var listeners = []
      return {
        getSnapshot: function () { return state },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            listeners = listeners.filter(function (entry) { return entry !== listener })
          }
        },
        update: function (patch) {
          var next = {}
          for (var key in state) if (Object.prototype.hasOwnProperty.call(state, key)) next[key] = state[key]
          patch(next)
          state = next
          for (var i = 0; i < listeners.length; i++) listeners[i]()
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /**
     * Read the namespace and the provider directory in one round trip.
     *
     * Reload is idempotent, so both the initial mount and a pushed
     * `settings/document-updated` go through here — that is what keeps the page
     * honest when someone edits settings.yaml by hand underneath it.
     */
    function load(api, store) {
      return Promise.all([api.settings.describe({ redactSecrets: true }), api.llm.providers({})])
        .then(function (results) {
          var settingsResult = results[0]
          var providersResult = results[1]
          if (!settingsResult.result.ok) throw new Error(settingsResult.result.error.message)
          if (!providersResult.result.ok) throw new Error(providersResult.result.error.message)
          var namespaces = settingsResult.result.value.namespaces || []
          var view = namespaces.filter(function (entry) { return entry.ns === NAMESPACE })[0]
          store.update(function (state) {
            state.status = 'ready'
            state.value = (view && view.value) || {}
            state.readOnly = settingsResult.result.value.writable === false
            state.options = optionsFrom(providersResult.result.value.providers, view)
            state.error = undefined
          })
        })
        .catch(function (error) {
          store.update(function (state) {
            state.status = 'error'
            state.error = error instanceof Error ? error.message : String(error)
          })
        })
    }

    function Field(props) {
      return h('label', { className: 'dshl_field' },
        h('span', { className: 'dshl_fieldLabel' }, props.label),
        props.children)
    }

    function LaneEditor(props) {
      var api = props.api
      var t = props.t
      var store = props.store
      var state = useStore(store)
      var draft = React.useState(null)
      var edit = draft[0]
      var setEdit = draft[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var failState = React.useState(undefined)
      var failure = failState[0]
      var setFailure = failState[1]

      React.useEffect(function () {
        if (state.status === 'idle') load(api, store)
      }, [])

      if (state.status === 'idle') return h('p', { className: 'dshl_hint' }, t('loading'))
      if (state.status === 'error') {
        return h(React.Fragment, null,
          h('p', { className: 'dshl_error' }, t('loadFailed') + ': ' + state.error),
          h('button', { type: 'button', className: 'dshl_button dshl_secondary', onClick: function () { load(api, store) } }, t('retry')))
      }

      var value = state.value || {}
      var working = edit || {
        modelProvider: value.modelProvider || '',
        model: value.model || '',
        maxTokens: value.maxTokens === undefined ? 16384 : value.maxTokens,
        allow: value.allow || [],
      }
      var patch = function (next) { setEdit(Object.assign({}, working, next)) }
      var options = state.options || []
      var risky = riskyTools(working.allow)
      var dirty = edit !== null

      var commit = function () {
        setBusy(true)
        setFailure(undefined)
        save(api, working).then(function () {
          setBusy(false)
          setEdit(null)
          return load(api, store)
        }).catch(function (error) {
          setBusy(false)
          setFailure(error instanceof Error ? error.message : String(error))
        })
      }

      return h(React.Fragment, null,
        h('div', { className: 'dshl_grid' },
          h(Field, { label: t('provider') },
            h('select', {
              className: 'dshl_input',
              value: working.modelProvider,
              disabled: state.readOnly,
              onChange: function (event) { patch({ modelProvider: event.target.value, model: '' }) },
            }, [h('option', { key: '__none', value: '' }, t('none'))].concat(
              Array.from(new Set(options.map(function (option) { return option.provider }))).map(function (provider) {
                return h('option', { key: provider, value: provider }, provider)
              })))),
          h(Field, { label: t('model') },
            h('select', {
              className: 'dshl_input',
              value: working.model,
              disabled: state.readOnly,
              onChange: function (event) { patch({ model: event.target.value }) },
            }, [h('option', { key: '__none', value: '' }, t('none'))].concat(
              options.filter(function (option) { return option.provider === working.modelProvider }).map(function (option) {
                return h('option', { key: option.id, value: option.id }, option.id)
              })))),
          h(Field, { label: t('maxTokens') },
            h('input', {
              className: 'dshl_input',
              type: 'number',
              min: 1,
              step: 1024,
              value: working.maxTokens,
              disabled: state.readOnly,
              onChange: function (event) { patch({ maxTokens: Number(event.target.value) }) },
            }))),
        options.length === 0 ? h('p', { className: 'dshl_hint' }, t('unconfigured')) : null,
        h('fieldset', { className: 'dshl_fieldset' },
          h('legend', null, t('tools')),
          h('p', { className: 'dshl_hint' }, t('toolsHint')),
          h('div', { className: 'dshl_checks' }, TOOLS.map(function (tool) {
            return h('label', { key: tool.name, className: 'dshl_check' },
              h('input', {
                type: 'checkbox',
                checked: working.allow.indexOf(tool.name) !== -1,
                disabled: state.readOnly,
                onChange: function (event) {
                  patch({
                    allow: event.target.checked
                      ? working.allow.concat([tool.name])
                      : working.allow.filter(function (entry) { return entry !== tool.name }),
                  })
                },
              }),
              ' ' + tool.name,
              tool.risky === true ? h('span', { className: 'dshl_risk' }, '⚠') : null)
          }))),
        risky.length === 0 ? null : h('p', { className: 'dshl_warn' }, t('riskWarning') + ' (' + risky.join(', ') + ')'),
        state.readOnly ? h('p', { className: 'dshl_notice' }, t('readOnly')) : null,
        failure === undefined ? null : h('p', { className: 'dshl_error', role: 'alert' }, t('failed') + ': ' + failure),
        h('div', { className: 'dshl_actions' },
          h('button', {
            type: 'button',
            className: 'dshl_button dshl_primary',
            disabled: state.readOnly || busy || !dirty || working.model === '' || working.allow.length === 0,
            onClick: commit,
          }, busy ? t('applying') : t('apply')),
          dirty ? h('button', {
            type: 'button',
            className: 'dshl_button dshl_secondary',
            disabled: busy,
            onClick: function () { setEdit(null); setFailure(undefined) },
          }, t('cancel')) : null),
        h('p', { className: 'dshl_hint' }, t('current') + ': ' + (value.model === undefined || value.model === ''
          ? t('none')
          : value.modelProvider + '/' + value.model + ' · ' + value.maxTokens + ' · [' + (value.allow || []).join(', ') + ']')))
    }

    function CheapLaneSection(props) {
      var api = props.api
      var t = props.t
      var store = props.store
      if (api === undefined || t === undefined || store === undefined) return null
      return h('div', { className: 'dshl_section' },
        h('h2', { className: 'dshl_title' }, t('title')),
        h('p', { className: 'dshl_intro' }, t('intro')),
        h(LaneEditor, { api: api, t: t, store: store }))
    }

    var inject = ['slots', 'locale', 'connection', 'remote']

    /**
     * Register the section, and keep it fresh on pushed invalidations.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }) }, 'cheap-lane: copy dictionaries')
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
        var style = document.createElement('style')
        style.setAttribute('data-plugin-css', CSS_ID)
        style.textContent = css
        document.head.appendChild(style)
      }
      var connection = ctx.get('connection')
      var t = ctx.locale.bind(LOCALE_NS)
      var store = createStore()
      var injected = function () { return { api: connection.api, t: t, store: store } }
      ctx.effect(function () {
        var disposers = [
          // Someone edited settings.yaml by hand, or another surface wrote it.
          ctx.remote.$on('settings/document-updated', function () { load(connection.api, store) }),
          ctx.on('connection/reset', function () { load(connection.api, store) }),
        ]
        return function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]()
        }
      }, 'cheap-lane: pushed invalidations')
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'cheap-lane',
          order: 6,
          label: function () { return t('nav') },
          inject: injected,
        }, CheapLaneSection)
      })
    }

    exports.apply = apply
    exports.inject = inject
    // testable surface, harmless in the browser
    exports.NAMESPACE = NAMESPACE
    exports.riskyTools = riskyTools
    exports.getPath = getPath
    exports.optionsFrom = optionsFrom
    exports.save = save
    exports.createStore = createStore
    return module.exports
  },
})
