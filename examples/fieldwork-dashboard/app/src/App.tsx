import { useState, type ReactNode } from 'react';

/* ---------- inline lucide-style icons (ISC, lucide-static) ---------- */

const ICON_PATHS: Record<string, ReactNode> = {
  calendar: (
    <>
      <path d="M8 2v3" />
      <path d="M16 2v3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  search: (
    <>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  layers: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </>
  ),
  'chart-column': (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </>
  ),
  'layout-grid': (
    <>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </>
  ),
  bell: (
    <>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'arrow-left': (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  'arrow-up-right': (
    <>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </>
  ),
  'arrow-up': (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  ellipsis: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
};

/* The brand mark: four rounded squares, the top-right one a lighter sage. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="12" height="12" rx="3.5" fill="#194d42" />
      <rect x="15" y="1" width="12" height="12" rx="3.5" fill="#9db18f" />
      <rect x="1" y="15" width="12" height="12" rx="3.5" fill="#194d42" />
      <rect x="15" y="15" width="12" height="12" rx="3.5" fill="#194d42" />
    </svg>
  );
}

function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* ---------- data ---------- */

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'layout-grid' },
  { id: 'projects', label: 'Projects', icon: 'layers', badge: '12' },
  { id: 'insights', label: 'Data & insights', icon: 'chart-column' },
  { id: 'schedule', label: 'Schedule', icon: 'calendar' },
  { id: 'team', label: 'Team members', icon: 'users' },
];

const STATS = [
  { id: 'T14', label: 'Active projects', value: '12', icon: 'layers', cap: '+2 this month' },
  { id: 'T15', label: 'Data points collected', value: '24,806', icon: 'chart-column', cap: '18.6% vs. last month', up: true },
  { id: 'T17', label: 'Sites monitored', value: '40', icon: 'layout-grid', cap: '+6 new locations' },
  { id: 'T18', label: 'Team members', value: '18', icon: 'users', cap: '3 teams in the field' },
];

/* Bar heights are percentages of the 1.5k plot height, measured from the screenshot. */
const OBSERVATIONS = [25, 38.2, 30.6, 45.8, 40.3, 59.7, 52.1, 71.5, 62.5, 79.9, 73.6, 91.7];
const SAMPLES = [14.6, 22.9, 18.1, 27.8, 24.3, 36.8, 31.9, 44.4, 38.2, 49.3, 45.8, 56.9];
const X_LABELS = ['01 Oct', '05 Oct', '10 Oct', '15 Oct', '20 Oct', '25 Oct'];

const PROJECTS = [
  { n: '01', name: 'Water quality baseline', cat: 'Environmental', sites: '12 sites', lead: 'Maya Chen', status: 'In progress', tone: 'green', pct: 68 },
  { n: '02', name: 'Urban canopy mapping', cat: 'Biodiversity', sites: '08 sites', lead: 'Daniel Okoro', status: 'In review', tone: 'amber', pct: 92 },
  { n: '03', name: 'Coastal erosion watch', cat: 'Geography', sites: '06 sites', lead: 'Sofia Patel', status: 'In progress', tone: 'green', pct: 41 },
  { n: '04', name: 'Community air study', cat: 'Environmental', sites: '14 sites', lead: 'Alex Rivera', status: 'Planned', tone: 'grey', pct: 15 },
];

const NAV_WIDTH = 215;

export function App() {
  const [active, setActive] = useState('overview');
  const [drawer, setDrawer] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);

  return (
    <div className="app" data-i2c-container="app">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      {/* ---------------- sidebar ---------------- */}
      <aside id="sidebar-drawer" className={drawer ? 'sidebar is-open' : 'sidebar'} data-i2c-container="sidebar">
        <div className="brand">
          <BrandMark />
          <span className="brand-word" data-i2c-id="T2">
            fieldwork<sup className="brand-r">®</sup>
          </span>
        </div>

        <div className="workspace">
          <button
            id="workspace-switcher"
            className="workspace-btn"
            aria-haspopup="true"
            aria-controls="workspace-menu"
            aria-expanded={workspaceMenu}
            onClick={() => setWorkspaceMenu((v) => !v)}
          >
            <span className="workspace-avatar" aria-hidden="true">
              N
            </span>
            <span className="workspace-text">
              <span className="workspace-name" data-i2c-id="T6">
                Northstar Research
              </span>
              <span className="workspace-tier" data-i2c-id="T11">
                TEAM WORKSPACE
              </span>
            </span>
            <Icon name="chevron-down" size={14} className="workspace-chevron" />
          </button>
          <ul id="workspace-menu" className="workspace-menu" role="menu" hidden={!workspaceMenu}>
              <li role="none">
                <button role="menuitem" type="button" className="workspace-menu-item is-current">
                  Northstar Research
                </button>
              </li>
              <li role="none">
                <button role="menuitem" type="button" className="workspace-menu-item">
                  Riverside Survey Unit
                </button>
              </li>
              <li role="none">
                <button role="menuitem" type="button" className="workspace-menu-item">
                  Estuary Monitoring
                </button>
              </li>
          </ul>
        </div>

        <p className="eyebrow" data-i2c-id="T13">
          Workspace
        </p>

        <nav className="nav" aria-label="Workspace">
          {NAV.map((item) => (
            <button
              key={item.id}
              id={`nav-${item.id}`}
              type="button"
              className={active === item.id ? 'nav-item is-active' : 'nav-item'}
              aria-current={active === item.id ? 'page' : undefined}
              onClick={() => {
                setActive(item.id);
                setDrawer(false);
              }}
            >
              <Icon name={item.icon} size={17} />
              <span className="nav-label">{item.label}</span>
              {item.badge && (
                <span className="nav-badge" data-i2c-id="T25">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="nav-item nav-item--plain" onClick={() => setActive('settings')}>
            <Icon name="sun" size={17} />
            <span className="nav-label" data-i2c-id="T88">
              Settings
            </span>
          </button>

          <hr className="rule" />

          <div className="storage">
            <div className="storage-head">
              <span data-i2c-id="T91">Workspace storage</span>
              <span className="storage-pct" data-i2c-id="T92">
                72%
              </span>
            </div>
            <div
              className="meter"
              role="progressbar"
              aria-label="Workspace storage"
              aria-valuenow={72}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span className="meter-fill" style={{ width: '72%' }} />
            </div>
            <p className="storage-cap" data-i2c-id="T98">
              7.2 GB of 10 GB used
            </p>
          </div>

          <hr className="rule" />

          <button type="button" className="user" onClick={() => setActive('account')}>
            <span className="user-avatar" data-i2c-id="U27">
              JL
            </span>
            <span className="user-text">
              <span className="user-name" data-i2c-id="T101">
                Jamie Lewis
              </span>
              <span className="user-role" data-i2c-id="T103">
                Workspace admin
              </span>
            </span>
            <Icon name="chevron-down" size={14} className="user-chevron" />
          </button>
        </div>
      </aside>

      {drawer && <button className="scrim" type="button" aria-label="Close navigation" onClick={() => setDrawer(false)} />}

      {/* ---------------- main column ---------------- */}
      <div className="main">
        <header className="topbar" data-i2c-container="topbar">
          <button
            id="menu-button"
            type="button"
            className="iconbtn menu-button"
            aria-label="Toggle navigation"
            aria-haspopup="true"
            aria-controls="sidebar-drawer"
            aria-expanded={drawer}
            onClick={() => setDrawer((v) => !v)}
          >
            <Icon name={drawer ? 'x' : 'menu'} size={20} />
          </button>

          <nav className="crumbs" aria-label="Breadcrumb">
            <span className="crumb" data-i2c-id="T3">
              Workspace
            </span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="crumb crumb--current" data-i2c-id="T4">
              Overview
            </span>
          </nav>

          <div className="topbar-right">
            <label className="search">
              <Icon name="search" size={15} />
              <input type="search" placeholder="Search anything…" aria-label="Search anything" data-i2c-id="T5" />
            </label>
            <button type="button" className="iconbtn" aria-label="Notifications" data-i2c-id="T1">
              <Icon name="bell" size={18} />
            </button>
            <span className="avatar avatar--top" data-i2c-id="U2">
              JL
            </span>
          </div>
        </header>

        <main className="content" id="content">
          {/* page heading */}
          <section className="pagehead" data-i2c-container="pagehead">
            <div className="pagehead-text">
              <h1 data-i2c-id="T7">A clearer view of your fieldwork.</h1>
              <p className="lede" data-i2c-id="T12">
                Good morning, Jamie. Here’s what’s happening across your research.
              </p>
            </div>
            <div className="pagehead-actions">
              <button type="button" className="btn btn--ghost">
                <Icon name="calendar" size={17} />
                <span data-i2c-id="T8">Oct 1 – 31, 2026</span>
              </button>
              <button type="button" className="btn btn--primary">
                <Icon name="plus" size={16} />
                <span data-i2c-id="T10">New project</span>
              </button>
            </div>
          </section>

          {/* KPI cards */}
          <section className="stats" data-i2c-container="stats">
            {STATS.map((s) => (
              <article className="card stat" key={s.label}>
                <div className="stat-head">
                  <span className="stat-label" data-i2c-id={s.id}>
                    {s.label}
                  </span>
                  <Icon name={s.icon} size={17} className="stat-icon" />
                </div>
                <p className="stat-value">{s.value}</p>
                <p className="stat-cap">
                  {s.up && <Icon name="arrow-up" size={12} className="stat-arrow" />}
                  <span data-i2c-id={s.id === 'T15' ? 'T27' : undefined}>{s.cap}</span>
                </p>
              </article>
            ))}
          </section>

          {/* charts row */}
          <section className="charts">
            <article className="card activity" data-i2c-container="activityCard">
              <div className="card-head">
                <div>
                  <h2 data-i2c-id="T32">Collection activity</h2>
                  <p className="card-sub" data-i2c-id="T37">
                    Data collected across all active projects
                  </p>
                </div>
                <div className="select-wrap">
                  <select className="select" defaultValue="month" aria-label="Activity range" data-i2c-id="T35">
                    <option value="week">This week</option>
                    <option value="month">This month</option>
                    <option value="quarter">This quarter</option>
                  </select>
                  <Icon name="chevron-down" size={14} className="select-chevron" />
                </div>
              </div>

              <ul className="legend">
                <li>
                  <span className="swatch swatch--dark" aria-hidden="true" />
                  <span data-i2c-id="T41">Observations</span>
                </li>
                <li>
                  <span className="swatch swatch--light" aria-hidden="true" />
                  <span data-i2c-id="T42">Samples</span>
                </li>
              </ul>

              <div className="chart">
                <div className="chart-yaxis" aria-hidden="true">
                  <span style={{ top: '0%' }}>1.5k</span>
                  <span style={{ top: '33.333%' }}>1.0k</span>
                  <span style={{ top: '66.666%' }}>500</span>
                  <span style={{ top: '100%' }}>0</span>
                </div>
                <div className="chart-body">
                  <div className="chart-grid" aria-hidden="true">
                    <span className="gridline gridline--dashed" style={{ top: '0%' }} />
                    <span className="gridline gridline--dashed" style={{ top: '33.333%' }} />
                    <span className="gridline gridline--dashed" style={{ top: '66.666%' }} />
                    <span className="gridline gridline--solid" style={{ top: '100%' }} />
                  </div>
                  <div
                    className="chart-bars"
                    role="img"
                    aria-label="Observations and samples collected per two-day interval from 1 to 25 October"
                  >
                    {OBSERVATIONS.map((h, i) => (
                      <div className="bar-group" key={i}>
                        <span className="bar bar--dark" style={{ height: `${h}%` }} />
                        <span className="bar bar--light" style={{ height: `${SAMPLES[i]}%` }} />
                      </div>
                    ))}
                  </div>
                  <div className="chart-xaxis" aria-hidden="true">
                    {X_LABELS.map((label, i) => (
                      <span key={label} style={{ left: `${11 + i * 84}px` }} data-i2c-id={label === '01 Oct' ? 'U18' : label === '05 Oct' ? 'U19' : label === '10 Oct' ? 'T48' : label === '15 Oct' ? 'T49' : label === '20 Oct' ? 'T50' : 'T51'}>
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </article>

            <article className="card field" data-i2c-container="fieldCard">
              <div className="card-head">
                <div>
                  <h2 data-i2c-id="T33">In the field</h2>
                  <p className="card-sub" data-i2c-id="T38">
                    North district · 5 teams active
                  </p>
                </div>
                <span className="live">
                  <span className="live-dot" aria-hidden="true" />
                  <span data-i2c-id="T36">Live updates</span>
                </span>
              </div>
              <img className="map" src="/assets/mapDistrict.png" alt="Illustrated district map showing five active survey sites along a river between North Quarter, Old Town and Riverside" width={429} height={225} />
            </article>
          </section>

          {/* projects table */}
          <section className="card projects" data-i2c-container="projectsCard">
            <div className="card-head projects-head">
              <div>
                <h2 data-i2c-id="T52">Active projects</h2>
                <p className="card-sub" data-i2c-id="T54">
                  Keep your research moving forward
                </p>
              </div>
              <button type="button" className="btn btn--ghost btn--sm">
                <span data-i2c-id="T53">View all projects</span>
                <Icon name="arrow-up-right" size={13} />
              </button>
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col" data-i2c-id="T55">
                      Project name
                    </th>
                    <th scope="col" data-i2c-id="T56">
                      Sites
                    </th>
                    <th scope="col" data-i2c-id="T57">
                      Project lead
                    </th>
                    <th scope="col" data-i2c-id="T58">
                      Status
                    </th>
                    <th scope="col" data-i2c-id="U20">
                      Progress
                    </th>
                    <th scope="col">
                      <span className="sr-only">Row actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PROJECTS.map((p) => (
                    <tr key={p.n}>
                      <th scope="row" className="cell-project">
                        <span className="row-num" data-i2c-id={`row-${p.n}`}>
                          {p.n}
                        </span>
                        <span className="cell-project-text">
                          <span className="project-name">{p.name}</span>
                          <span className="project-cat">{p.cat}</span>
                        </span>
                      </th>
                      <td data-label="Sites">{p.sites}</td>
                      <td data-label="Project lead">{p.lead}</td>
                      <td data-label="Status">
                        <span className={`pill pill--${p.tone}`}>{p.status}</span>
                      </td>
                      <td data-label="Progress">
                        <span className="progress">
                          <span className="progress-track">
                            <span className="progress-fill" style={{ width: `${p.pct}%` }} />
                          </span>
                          <span className="progress-pct">{p.pct}%</span>
                        </span>
                      </td>
                      <td className="cell-more">
                        <button type="button" className="iconbtn iconbtn--sm" aria-label={`Actions for ${p.name}`}>
                          <Icon name="ellipsis" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="projects-foot">
              <p data-i2c-id="T85">Showing 4 of 12 projects</p>
              <nav className="pager" aria-label="Projects pagination">
                <button type="button" className="pager-nav" disabled>
                  <Icon name="arrow-left" size={14} />
                  <span data-i2c-id="T86">Previous</span>
                </button>
                <span className="pager-nums" data-i2c-id="pageNums">
                  <button type="button" className="pager-num is-current" aria-current="page">
                    1
                  </button>
                  <button type="button" className="pager-num">
                    2
                  </button>
                  <button type="button" className="pager-num">
                    3
                  </button>
                </span>
                <button type="button" className="pager-nav">
                  <span data-i2c-id="T87">Next</span>
                  <Icon name="arrow-right" size={14} />
                </button>
              </nav>
            </div>
          </section>

          {/* bottom row */}
          <section className="bottom" data-i2c-container="bottomRow">
            <article className="card upcoming" data-i2c-container="upnextCard">
              <h2 data-i2c-id="T89">Coming up next</h2>
              <div className="event">
                <div className="date-chip">
                  <span className="date-month" data-i2c-id="U25">
                    OCT
                  </span>
                  <span className="date-day" data-i2c-id="T97">
                    16
                  </span>
                </div>
                <div className="event-text">
                  <p className="event-title" data-i2c-id="T95">
                    North district sampling session
                  </p>
                  <p className="event-meta">
                    <span data-i2c-id="T99">09:00 – 12:30</span>
                    <span className="dot" aria-hidden="true" />
                    <span data-i2c-id="T100">Riverside station</span>
                  </p>
                </div>
                <div className="event-people">
                  <span className="stack">
                    <span className="stack-a" style={{ background: '#dee5d8' }}>
                      MC
                    </span>
                    <span className="stack-a" style={{ background: '#f2e6d4' }}>
                      DO
                    </span>
                    <span className="stack-a stack-a--more" data-i2c-id="T96">
                      +3
                    </span>
                  </span>
                </div>
              </div>
            </article>

            <article className="card promo" data-i2c-container="promoCard">
              <Icon name="layers" size={44} className="promo-icon" />
              <div>
                <h2 className="promo-title" data-i2c-id="T90">
                  Small observations. Bigger discoveries.
                </h2>
                <p className="promo-copy" data-i2c-id="T93">
                  Your team collected <strong data-i2c-id="T94">1,240 data points this week</strong>.
                  <br />
                  That’s another step toward a better understanding.
                </p>
              </div>
            </article>
          </section>

          <footer className="foot" data-i2c-container="footer">
            <p data-i2c-id="T102">All changes saved · Last synced just now</p>
            <a className="foot-link" href="#help">
              <span data-i2c-id="T104">Help center</span>
              <Icon name="arrow-up-right" size={12} />
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}
