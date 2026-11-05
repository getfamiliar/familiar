import { GalleryVerticalEndIcon } from "lucide-react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

/**
 * Top of the sidebar: app icon, name and the running familiar version.
 * Links to the start page.
 *
 * @param props.version Familiar version, or null while loading.
 * @returns The brand row.
 */
export function AppBrand({ version }: { readonly version: string | null }) {
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                    <a href="/">
                        <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                            <GalleryVerticalEndIcon className="size-4" />
                        </div>
                        <div className="grid flex-1 text-left text-sm leading-tight">
                            <span className="truncate font-medium">Familiar</span>
                            <span className="truncate text-xs">
                                {version === null ? " " : `v${version}`}
                            </span>
                        </div>
                    </a>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
