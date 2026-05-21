declare module "friendly-node-cron" {
    /**
     * Translate a friendly schedule expression (`every monday at 8`,
     * `every 5 minutes`, …) to a 6-field cron string. Returns `null`
     * when the input does not match any friendly pattern.
     */
    const translate: (expression: string) => string | null;
    export default translate;
}
