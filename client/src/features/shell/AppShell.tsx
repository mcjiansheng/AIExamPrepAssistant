// 外壳：手机底部标签栏 + 助手输入条；平板左侧窄栏 + 右侧抽屉；lg 窄栏 + 课程色点 + 常驻助手；xl 整条侧栏（10 第 4.1 节）。
import type { CSSProperties } from 'react';
import { NavLink, Outlet, useLocation, useMatch } from 'react-router';
import { useCourses, useNotifications } from '../../api/hooks';
import { cx } from '../../lib/cx';
import { isCompact, useBreakpoint } from '../../state/breakpoint';
import { useSession } from '../../state/session';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Button, IconButton } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { Sheet } from '../../ui/Sheet';
import { AssistantPanel } from '../assistant/AssistantPanel';
import css from './shell.module.css';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: s.nav.today, icon: 'today', end: true },
  { to: '/courses', label: s.nav.courses, icon: 'courses' },
  { to: '/practice', label: s.nav.practice, icon: 'practice' },
  { to: '/me', label: s.nav.me, icon: 'me' },
];
const WIDE_NAV = [NAV[0]!, NAV[1]!, NAV[2]!, { to: '/schedule', label: s.nav.schedule, icon: 'schedule' as IconName }, NAV[3]!];
const TAB_ROOTS = ['/', '/courses', '/practice', '/me'];
const PANEL = { md: 360, lg: 340, xl: 380 };

export function Logo({ size = 28 }: { size?: number }) {
  const c = size / 2 - 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {[[0, 0, 'var(--mastery-mastered)'], [1, 0, 'var(--mastery-mastered)'], [0, 1, 'var(--mastery-mastered)'], [1, 1, 'var(--mastery-shaky)']].map(([x, y, fill]) => (
        <rect key={`${x}${y}`} x={(x as number) * (c + 4)} y={(y as number) * (c + 4)} width={c} height={c} rx={c * 0.25} fill={fill as string} />
      ))}
    </svg>
  );
}

export function AppShell() {
  const bp = useBreakpoint();
  const location = useLocation();
  const user = useSession((st) => st.user);
  const { assistantOpen, assistantCollapsed, openAssistant, closeAssistant, setCollapsed } = useUi();
  const compact = isCompact(bp);
  const isRoot = TAB_ROOTS.includes(location.pathname);
  // 手机上的助手输入条只在主页面（标签页和课程主页）出现；推入的页面有自己的底部操作区
  const courseHome = useMatch('/c/:cid');
  const onChat = location.pathname.startsWith('/chat/');
  const showBar = compact && !onChat && (isRoot || !!courseHome);
  const docked = (bp === 'lg' || bp === 'xl') && !onChat;
  const panelWidth = bp === 'xl' ? PANEL.xl : bp === 'lg' ? PANEL.lg : PANEL.md;
  const left = compact ? 0 : bp === 'xl' ? 248 : 80;
  const right = docked ? (assistantCollapsed ? 48 : panelWidth) : 0;
  const style = { '--left': `${left}px`, '--right': `${right}px`, '--panel-width': `${panelWidth}px` } as CSSProperties;
  return (
    <div className={cx(css.shell, compact && css.compact, !showBar && css.noBar, compact && !isRoot && css.noTabs)} style={style}>
      {bp === 'xl' ? <Sidebar /> : !compact ? <Rail wide={bp === 'lg'} /> : null}
      <main className={css.main} id="main">
        {user?.guest && <GuestBanner />}
        <Outlet />
      </main>
      {compact && isRoot && <TabBar />}
      {showBar && <AssistantBar onOpen={() => openAssistant()} />}
      {compact && (
        <Sheet open={assistantOpen} onClose={closeAssistant} size="full" label={s.assistant.title}>
          <AssistantPanel embedded onClose={closeAssistant} />
        </Sheet>
      )}
      {bp === 'md' && !onChat && (
        <>
          {!assistantOpen && <button type="button" className={css.fab} onClick={() => openAssistant()}><Icon name="assistant" />{s.assistant.title}</button>}
          <aside className={cx(css.dock, css.drawer, !assistantOpen && css.drawerClosed)} aria-label={s.assistant.title} aria-hidden={!assistantOpen}>
            {assistantOpen && <AssistantPanel onClose={closeAssistant} />}
          </aside>
        </>
      )}
      {docked && (assistantCollapsed ? (
        <div className={css.edge}>
          <IconButton icon="panelOpen" label="展开助手" onClick={() => setCollapsed(false)} />
          <IconButton icon="assistant" label={s.assistant.title} onClick={() => setCollapsed(false)} />
        </div>
      ) : (
        <aside className={css.dock} aria-label={s.assistant.title}>
          <AssistantPanel onCollapse={() => setCollapsed(true)} />
        </aside>
      ))}
    </div>
  );
}

function TabBar() {
  return (
    <nav className={css.tabs} aria-label="主导航">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={css.tab}>
          <Icon name={n.icon} size={24} />
          <span>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function AssistantBar({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className={css.bar} onClick={onOpen}>
      <Icon name="assistant" tone="accent" />
      <span className={css.barText}>{s.assistant.placeholder}</span>
      <span style={{ display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 18, background: 'var(--accent)', color: '#fff' }}><Icon name="send" size={18} /></span>
    </button>
  );
}

function Bell() {
  const n = useNotifications();
  return <IconButton icon="bell" label={s.nav.notifications} to="/notifications" badge={!!n.data?.unread} />;
}

function Rail({ wide }: { wide: boolean }) {
  const courses = useCourses();
  return (
    <nav className={css.rail} aria-label="主导航">
      <div className={css.logo}><Logo /></div>
      {WIDE_NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={css.railItem}>
          <Icon name={n.icon} size={24} />
          <span>{n.label}</span>
        </NavLink>
      ))}
      {wide && (
        <div className={css.railCourses}>
          {(courses.data ?? []).map((c) => (
            <NavLink key={c.id} to={`/c/${c.id}`} className={css.courseDot} style={{ background: `var(--course-${c.color % 8})` }} aria-label={`${c.name}${c.days_left !== null ? `，还有 ${c.days_left} 天` : ''}`} title={c.name}>
              {c.name.slice(0, 1)}
            </NavLink>
          ))}
          <IconButton icon="plus" label={s.action.addCourse} to="/courses/new" size="sm" />
        </div>
      )}
      <div className={css.railFoot}><Bell /></div>
    </nav>
  );
}

function Sidebar() {
  const courses = useCourses();
  return (
    <nav className={css.side} aria-label="主导航">
      <div className={css.brand}><Logo />{s.app.name}</div>
      {WIDE_NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={css.sideItem}>
          <Icon name={n.icon} />
          <span>{n.label}</span>
        </NavLink>
      ))}
      <div className={css.sideLabel}>{s.nav.courses}</div>
      {(courses.data ?? []).map((c) => (
        <NavLink key={c.id} to={`/c/${c.id}`} className={css.sideCourse}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(--course-${c.color % 8})`, flex: 'none' }} aria-hidden />
          <span className={css.sideCourseName}>{c.name}</span>
          {c.days_left !== null && c.days_left >= 0 && <span className={cx(css.days, c.days_left <= 3 && css.daysUrgent)}>{c.days_left}天</span>}
        </NavLink>
      ))}
      <NavLink to="/courses/new" className={css.sideCourse} style={{ color: 'var(--accent)' }}>
        <Icon name="plus" size={18} />{s.action.addCourse}
      </NavLink>
      <div style={{ marginTop: 'auto', paddingTop: 16 }}><Bell /></div>
    </nav>
  );
}

function GuestBanner() {
  const requestLogin = useUi((st) => st.requestLogin);
  return (
    <div className={css.guest} role="status">
      <span>{s.auth.guestBanner} · {s.auth.loginToSave}</span>
      <Button variant="text" size="sm" onClick={() => void requestLogin()}>{s.action.login}</Button>
    </div>
  );
}
