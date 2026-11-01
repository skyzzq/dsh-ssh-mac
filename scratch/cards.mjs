import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/client/panel/HostsTab.tsx'
let source = readFileSync(path, 'utf8')

const card = `  const renderHostCard = (host: SshHostSummary): ReactNode => {
    const test = testResults[host.alias]
    return (
      <li key={host.alias} className={css.hostCard}>
        <div className={css.hostHead}>
          <span className={\`\${css.hostAlias} \${css.mono}\`}>{host.alias}</span>
          {host.environment !== undefined && <span className={css.chip}>{host.environment}</span>}
          {host.proxyCommand !== undefined && (
            <span className={css.badge} data-kind="proxy" title={host.proxyCommand}>{tt('hosts.proxyBadge')}</span>
          )}
          {host.forwardAgent === true && (
            <span className={css.badge} data-kind="forward-agent" title={tt('hosts.forwardAgentHint')}>{tt('hosts.forwardAgentBadge')}</span>
          )}
          <span className={css.hostSpacer} />
          {test !== undefined && (
            <span className={css.inlineTest} data-status={test.ok ? 'ok' : 'fail'}>
              {test.ok ? tt('hosts.testOk', { latency: test.latencyMs ?? 0 }) : tt('hosts.testFail', { error: test.error ?? '' })}
            </span>
          )}
          <button type="button" className={css.primaryButton} onClick={() => { onConnect(host.alias) }}>{tt('hosts.connected')}</button>
        </div>
        <div className={css.hostAddr}>
          <span className={css.mono}>{host.host}:{host.port}</span>
          {host.mac !== undefined && (
            <span className={css.hostMac}>
              <span className={css.hostMacLabel}>{tt('hosts.col.mac')}</span>
              {host.mac}
            </span>
          )}
        </div>
        <div className={css.hostMeta}>
          <span>{host.user}</span>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.badge} data-kind={host.auth}>{host.auth === 'key' ? tt('form.auth.key') : host.auth === 'password' ? tt('form.auth.password') : tt('form.auth.agent')}</span>
          {host.tags.length > 0 && (
            <>
              <span className={css.dot} aria-hidden="true" />
              <span>{host.tags.join(' · ')}</span>
            </>
          )}
        </div>
        {host.description !== undefined && host.description !== '' && (
          <div className={css.hostDesc}>{host.description}</div>
        )}
        <div className={css.hostActions}>
          <button type="button" className={css.linkButton} disabled={testingAlias === host.alias} onClick={() => { void runTest(host.alias) }}>
            {testingAlias === host.alias ? tt('hosts.testing') : tt('hosts.test')}
          </button>
          {testingAlias === host.alias && <span className={css.spinner} aria-hidden="true" />}
          <button type="button" className={css.linkButton} onClick={() => { setDialog({ mode: 'edit', host }) }}>{tt('hosts.edit')}</button>
          <button type="button" className={css.linkButton} data-danger onClick={() => { void deleteHost(host.alias) }}>{tt('hosts.delete')}</button>
        </div>
      </li>
    )
  }

  const renderHostList = (rows: SshHostSummary[]): ReactNode => (
    <ul className={css.hostList}>
      {rows.map(renderHostCard)}
    </ul>
  )
`

const start = source.indexOf('  const renderHostRow = ')
const end = source.indexOf('  const groups = hosts === null')
if (start < 0 || end < 0) throw new Error('anchors not found')

source = source.slice(0, start) + card + '\n' + source.slice(end)
source = source.replace("{renderHostTable(hosts)}", "{renderHostList(hosts)}")
source = source.replace('{!isCollapsed && renderHostTable(group.hosts)}', '{!isCollapsed && renderHostList(group.hosts)}')
source = source.split('<div className={css.tableWrap}>').join('<div className={css.listWrap}>')

writeFileSync(path, source)
console.log('cards written; renderHostTable left:', /renderHostTable/.test(source))
