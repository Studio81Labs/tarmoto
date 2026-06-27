interface TopBarProps {
  email: string;
  role: string;
  onLogout: () => void;
}

export function TopBar({ email, role, onLogout }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__spacer" />
      <div className="topbar__user">
        <span className="topbar__email">{email}</span>
        <span className="topbar__role">{role}</span>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
