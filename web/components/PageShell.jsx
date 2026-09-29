import { FolderOpen, LayoutDashboard, UserRound, Users } from "lucide-react";
import Brand from "@/src/Brand";
import SignOutButton from "./SignOutButton";

/** Frame for the non-dashboard pages (library, compare, users, account). */
export default function PageShell({ user, active, title, eyebrow, actions, children }) {
  const links = [
    ["dashboard", "/", LayoutDashboard, "Dashboard"],
    ["scenarios", "/scenarios", FolderOpen, "Saved scenarios"],
    ...(user?.role === "admin" ? [["users", "/admin/users", Users, "Users"]] : []),
    ["account", "/account", UserRound, "Account"],
  ];
  return (
    <div className="page">
      <header className="topbar">
        <a href="/" className="topbar-brand" aria-label="Joulewise FDRE home"><Brand size="sm" /></a>
        <nav>
          {links.map(([id, href, Icon, label]) => (
            <a key={id} href={href} className={active === id ? "active" : ""}><Icon size={14} /> {label}</a>
          ))}
        </nav>
        <div className="topbar-user">
          <span>{user?.name || user?.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="page-main">
        <div className="page-head">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h1>{title}</h1>
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {children}
      </main>
      <footer className="page-foot"><img src="/brand/joulewise-mark.png" alt="" width={18} height={18} /> Joulewise · FDRE optimizer</footer>
    </div>
  );
}
