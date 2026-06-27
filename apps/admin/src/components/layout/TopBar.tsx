import { Pill, Button } from "@tarmoto/ui";

interface TopBarProps {
  email: string;
  role: string;
  onLogout: () => void;
}

export function TopBar({ email, role, onLogout }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-line bg-cream px-6">
      <span className="text-[13px] text-ink">{email}</span>
      <Pill variant="ghost">{role}</Pill>
      <Button variant="secondary" size="sm" onClick={onLogout}>
        Log out
      </Button>
    </header>
  );
}
