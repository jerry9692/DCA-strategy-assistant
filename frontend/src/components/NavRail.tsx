export type View = "overview" | "performance" | "comparison" | "optimization" | "montecarlo";

interface NavRailProps {
  activeView: View;
  onViewChange: (view: View) => void;
  onConfigOpen: () => void;
  onSettingsOpen: () => void;
}

const ICONS = {
  overview: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  performance: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  ),
  comparison: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 17.5L3 6V3h3l11.5 11.5" />
      <path d="M13 19l6-6" />
      <path d="M16 16l4 4" />
      <path d="M19 21l2-2" />
    </svg>
  ),
  optimization: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21l2.3-7.4-6-4.6h7.6z" />
    </svg>
  ),
  montecarlo: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20h18" />
      <path d="M4 16c2-4 4-4 6 0s4 4 6 0 4-4 4 0" opacity="0.4" />
      <path d="M4 16c2-3 4-3 6 0s4 3 6 0 4-3 4 0" />
      <path d="M4 16c2-2 4-2 6 0s4 2 6 0 4-2 4 0" strokeWidth="2.5" />
    </svg>
  ),
  config: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

export function NavRail({ activeView, onViewChange, onConfigOpen, onSettingsOpen }: NavRailProps) {
  const items: { view: View; label: string; icon: React.ReactNode }[] = [
    { view: "overview", label: "概览", icon: ICONS.overview },
    { view: "performance", label: "表现", icon: ICONS.performance },
    { view: "comparison", label: "对比", icon: ICONS.comparison },
    { view: "optimization", label: "调优", icon: ICONS.optimization },
    { view: "montecarlo", label: "推演", icon: ICONS.montecarlo },
  ];

  return (
    <nav className="nav-rail">
      {items.map((item) => (
        <button
          key={item.view}
          className={`nav-rail__item ${activeView === item.view ? "active" : ""}`}
          onClick={() => onViewChange(item.view)}
        >
          {item.icon}
          <span className="nav-rail__tooltip">{item.label}</span>
        </button>
      ))}
      <div className="nav-rail__spacer" />
      <button className="nav-rail__item" onClick={onConfigOpen}>
        {ICONS.config}
        <span className="nav-rail__tooltip">配置</span>
      </button>
      <button className="nav-rail__item" onClick={onSettingsOpen}>
        {ICONS.settings}
        <span className="nav-rail__tooltip">设置</span>
      </button>
    </nav>
  );
}
