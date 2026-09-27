import { MessageSquare, Upload, FileText, ShieldCheck, Home, BookOpen, Network } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const navItems = [
  { title: "Chat", url: "/dashboard", icon: MessageSquare },
  { title: "Upload Circular", url: "/dashboard/upload", icon: Upload },
  { title: "Browse Topics", url: "/dashboard/circulars", icon: FileText },
  { title: "Rules", url: "/dashboard/rules", icon: BookOpen },
  { title: "Compliance Checker", url: "/dashboard/compliance", icon: ShieldCheck },
  { title: "Exposure Network", url: "/dashboard/compliance?tab=network", icon: Network },
];

export function DashboardSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const onNetworkTab = new URLSearchParams(location.search).get("tab") === "network";
  const isActive = (url: string) => {
    const [path, query] = url.split("?");
    if (path === "/dashboard") return location.pathname === path;
    if (!location.pathname.startsWith(path)) return false;
    // "Compliance Checker" and "Exposure Network" share a page; the tab decides.
    return query ? onNetworkTab : !onNetworkTab;
  };
  // Keep the selected bank and period when moving between the two compliance links.
  const linkFor = (url: string) => {
    const [path, query] = url.split("?");
    if (path !== "/dashboard/compliance") return url;
    const current = new URLSearchParams(location.pathname.startsWith(path) ? location.search : "");
    const next = new URLSearchParams();
    for (const k of ["bank", "period"]) {
      const v = current.get(k);
      if (v) next.set(k, v);
    }
    const tab = new URLSearchParams(query ?? "").get("tab");
    if (tab) next.set("tab", tab);
    const qs = next.toString();
    return qs ? `${path}?${qs}` : path;
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className={collapsed ? "sr-only" : ""}>
            <NavLink to="/" className="flex items-center gap-2 text-sidebar-foreground hover:text-sidebar-primary transition-colors">
              <Home className="h-4 w-4" />
              {!collapsed && <span className="font-display font-semibold">RBI Assistant</span>}
            </NavLink>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)}>
                    <NavLink
                      to={linkFor(item.url)}
                      end={item.url === "/dashboard"}
                      className="hover:bg-sidebar-accent/50"
                      activeClassName={isActive(item.url) ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : ""}
                    >
                      <item.icon className="mr-2 h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
