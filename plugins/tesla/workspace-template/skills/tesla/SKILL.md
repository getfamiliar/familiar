---
name: tesla
description: The Tesla tools — what each one does, when to reach for it, and how to collect the monthly charging and connectivity invoices.
---

# Tesla

The `tesla_*` tools read the user's car through Tesla's owner API.

Reach for them when the user asks about the car by name or implicitly — "where's the car", "how full is it", "do I have the charging receipts for last month". Don't call them speculatively; a state read wakes a sleeping car, which costs a little battery and up to 30 seconds.

## You can only read. You cannot change anything on the car.

There are exactly five tools and all five are read-only. **Nothing you can do sends a command to the car.** Never offer, promise, or attempt any of these:

- setting the charge limit, or starting / stopping charging
- opening the charge port, the frunk, the trunk, or the windows
- locking or unlocking the doors
- turning climate on or off, preconditioning, defrost, dog or camp mode
- sending a navigation destination
- honking, flashing the lights, Sentry mode, starting a software update

**Reading a value is not permission to change it.** `tesla_info` shows you `charge_limit_soc`, the climate setting and the door locks — every one of those is a number you can report and *not* a setting you can touch. This is the mistake to guard against: the data looks like a control panel and it is not one.

When the user asks for any of the above, say in one sentence that you can't control the car, only read it, and that the change is in the Tesla app. Don't promise it for a future version and don't go hunting for another tool — there isn't one.

The reason is technical, if the user asks: Tesla requires cryptographically signed commands from a key paired inside the vehicle, and this integration has no way to hold such a key. The car itself reports `command_signing: required`.

## Units: distances are **miles**, temperatures are **Celsius**

Every distance and distance-derived value the API returns is in **miles**, regardless of what the car's display is set to: `odometer`, `battery_range`, `est_battery_range`, `ideal_battery_range`, anything named `*_range` or `*_miles_*`, and `speed` (mph).

**The trap:** `gui_settings.gui_distance_units` reports what the car's *screen* shows — for this user it says `km/hr`. The API values are miles anyway. Reading that field and concluding the numbers are kilometres is exactly the wrong inference.

So convert before you speak, and say which unit you mean:

> `odometer: 70875.885` → "about 114,000 km" (× 1.609)
> `battery_range: 67.28` at 24 % → "roughly 108 km left"

Temperatures are already **Celsius** — `inside_temp`, `outside_temp`, `driver_temp_setting`, `max_avail_temp`, `min_avail_temp`. Pass them through unchanged; converting those too is the opposite error.

Percentages (`battery_level`, `charge_limit_soc`) are percentages. Tyre pressures are bar.

## The tools

| Tool | Use it when |
|---|---|
| `tesla_invoices` | The user wants charging or connectivity receipts for bookkeeping. |
| `tesla_location` | "Where is the car?" — position plus when that was last established. |
| `tesla_info` | Anything about the car's state: charge, range, climate, doors, odometer, software. Mind the units above — convert miles to km. |
| `tesla_vehicles_list` | You need the vehicle ids, or the user asks which cars are on the account. |
| `tesla_set_default_vehicle` | The user has told you which car to use from now on. |

## Which car

Every tool acts on one default vehicle. With a single car on the account that is resolved silently and you will never notice.

With several cars and no default set yet, the tool comes back with `needs_vehicle_choice: true` and a table of the cars instead of an answer. That is **not an error** — show the user the list, ask which car they mean, call `tesla_set_default_vehicle` with that `id`, then retry the original tool. The choice sticks until it is changed, so you only ever do this once.

## Waking the car, and stale answers

A parked Tesla sleeps. `tesla_info` and `tesla_location` wake it and wait up to 30 seconds — expect the call to be slow, and don't fire it twice because the first one felt long.

If the car doesn't wake in time, the tool still answers, but from the last known state: the result carries `from_cache: true` and a `cached_at` timestamp. **Always pass that on.** Say "the car was last seen at … on …" rather than presenting a stale position as where it is now. Cached data is genuinely useful here — a car parked in a garage with no signal is still parked where it was — but only if the user knows how old it is.

## Collecting the monthly invoices

This is the main job. The user needs PDFs for bookkeeping, from two unrelated sources that `tesla_invoices` merges for you:

- **Supercharging** — one invoice per paid charging session, with the site name and the amount.
- **Connectivity** — the Premium Connectivity subscription, one invoice per billing period. The amount is only inside the PDF; see below.

Call it with no arguments to get the **last full month**, which is what "the invoices for last month" means in September for August. For anything else pass inclusive local days: `from_day: "2026-08-01"`, `to_day: "2026-08-31"`. Narrow to one source with `kind: "supercharging"` or `kind: "connectivity"` only when the user asked for just that — the default covers both and a missing connectivity invoice is easy to overlook.

The tool returns a table with one row per document: `filepath | kind | date | location | amount`. The files are already on disk at those paths.

**Connectivity invoices have no amount in the table, and that does not mean they were free.** Tesla's subscription endpoint returns only a date, an id and a filename — the figure exists nowhere but inside the PDF. Those rows therefore say `read the PDF at filepath — not in the API` in the `amount` column. When the user needs the sum, or you are listing what you found, `fs_read` the PDF and take the amount from there. Supercharger rows do carry their total, so only the connectivity ones need this.

**Finish the job in the same run.** The scratch directory is swept after 24 hours, so a path you leave lying around is worthless tomorrow. Before you finish, do whatever the user actually needs with the files — attach them to a mail, file them where the user keeps receipts, hand the paths to whichever tool takes them. If the user hasn't said what should happen to them, ask before you stop, and list what you found (how many, which months, what totals) so they can tell whether anything is missing.

Two things worth reporting rather than glossing over: a month with **no** invoices at all (either the car wasn't supercharged or the period is wrong — say which you think it is), and sessions on free supercharging, which produce no invoice by design and so simply won't appear.
