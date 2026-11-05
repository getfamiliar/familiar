import type { WebPrincipal } from "@getfamiliar/shared";
import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar";

/**
 * The signed-in user at the bottom of the sidebar: name, login and how
 * the core identified them (`via`, as on the `/login` page), with a
 * sign-out entry.
 *
 * @param props.user The signed-in user.
 * @returns The user menu.
 */
export function NavUser({ user }: { readonly user: WebPrincipal }) {
    const { isMobile } = useSidebar();
    const identity = <UserIdentity user={user} />;
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                        >
                            {identity}
                            <ChevronsUpDownIcon className="ml-auto size-4" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="w-fit"
                        side={isMobile ? "bottom" : "right"}
                        align="end"
                        sideOffset={4}
                    >
                        <DropdownMenuLabel className="p-0 font-normal">
                            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                                {identity}
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={signOut}>
                            <LogOutIcon />
                            Log out
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

/**
 * Avatar with initials, display name and {@link identitySubline}.
 *
 * @param props.user The signed-in user.
 * @returns The identity block.
 */
function UserIdentity({ user }: { readonly user: WebPrincipal }) {
    return (
        <>
            <Avatar className="h-8 w-8 rounded-lg">
                <AvatarFallback className="rounded-lg">
                    {toInitials(user.displayName)}
                </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.displayName}</span>
                <span className="truncate text-xs">{identitySubline(user)}</span>
            </div>
        </>
    );
}

/**
 * Subline under the name: `login · via <source>`, or just `via <source>`
 * when the name already is the login.
 *
 * @param user The signed-in user.
 * @returns The subline text.
 */
function identitySubline(user: WebPrincipal): string {
    return user.displayName === user.login ? `via ${user.via}` : `${user.login} · via ${user.via}`;
}

/**
 * Up to two initials of a display name or login for the avatar.
 *
 * @param name Display name or login.
 * @returns Uppercase initials.
 */
function toInitials(name: string): string {
    const words = name.split(/[\s@._-]+/).filter((word) => word !== "");
    return words
        .slice(0, 2)
        .map((word) => word[0]?.toUpperCase() ?? "")
        .join("");
}

/** Sign out through the core webserver's `POST /logout` (it redirects to `/login`). */
function signOut(): void {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/logout";
    document.body.append(form);
    form.submit();
}
