import type { WebMenuEntry } from "@getfamiliar/shared";
import { ChevronRightIcon, CircleIcon } from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
    SidebarGroup,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { isRouteActive } from "@/lib/menu";

/**
 * The plugin-contributed sidebar menu: direct links, and collapsible
 * groups whose sub-entries link to routes. A group with its own route
 * links there from its label and toggles from the chevron.
 *
 * @param props.items Sorted menu items from the core.
 * @param props.pathname Current page path, for the active state.
 * @returns The menu, or nothing for an empty menu.
 */
export function NavMain({
    items,
    pathname,
}: {
    readonly items: readonly WebMenuEntry[];
    readonly pathname: string;
}) {
    if (items.length === 0) {
        return null;
    }
    return (
        <SidebarGroup>
            <SidebarMenu>
                {items.map((item) => (
                    <NavItem
                        key={`${item.pluginId}:${item.label}`}
                        item={item}
                        pathname={pathname}
                    />
                ))}
            </SidebarMenu>
        </SidebarGroup>
    );
}

/**
 * One top-level menu item.
 *
 * @param props.item The item.
 * @param props.pathname Current page path.
 * @returns A link, or a collapsible group.
 */
function NavItem({ item, pathname }: { readonly item: WebMenuEntry; readonly pathname: string }) {
    const children = item.children ?? [];
    const isActive = isRouteActive(item.route, pathname);
    const icon = <MenuIcon name={item.icon} />;
    if (children.length === 0) {
        return (
            <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={item.label} isActive={isActive}>
                    <a href={item.route}>
                        {icon}
                        <span>{item.label}</span>
                    </a>
                </SidebarMenuButton>
            </SidebarMenuItem>
        );
    }
    const hasActiveChild = children.some((child) => isRouteActive(child.route, pathname));
    const chevron = (
        <ChevronRightIcon className="transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
    );
    return (
        <Collapsible asChild defaultOpen={isActive || hasActiveChild} className="group/collapsible">
            <SidebarMenuItem>
                {item.route === undefined ? (
                    <CollapsibleTrigger asChild>
                        <SidebarMenuButton tooltip={item.label}>
                            {icon}
                            <span>{item.label}</span>
                            <span className="ml-auto">{chevron}</span>
                        </SidebarMenuButton>
                    </CollapsibleTrigger>
                ) : (
                    <>
                        <SidebarMenuButton asChild tooltip={item.label} isActive={isActive}>
                            <a href={item.route}>
                                {icon}
                                <span>{item.label}</span>
                            </a>
                        </SidebarMenuButton>
                        <CollapsibleTrigger asChild>
                            <SidebarMenuAction>
                                {chevron}
                                <span className="sr-only">Toggle {item.label}</span>
                            </SidebarMenuAction>
                        </CollapsibleTrigger>
                    </>
                )}
                <CollapsibleContent>
                    <SidebarMenuSub>
                        {children.map((child) => (
                            <SidebarMenuSubItem key={`${child.label}:${child.route}`}>
                                <SidebarMenuSubButton
                                    asChild
                                    isActive={isRouteActive(child.route, pathname)}
                                >
                                    <a href={child.route}>
                                        <span>{child.label}</span>
                                    </a>
                                </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                        ))}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </SidebarMenuItem>
        </Collapsible>
    );
}

/**
 * A lucide icon by id, loaded on demand; unknown ids show a neutral dot.
 *
 * @param props.name Lucide icon id (kebab-case).
 * @returns The icon.
 */
function MenuIcon({ name }: { readonly name: string }) {
    return <DynamicIcon name={name as IconName} fallback={() => <CircleIcon />} />;
}
