import { PageHeader as UiPageHeader, type PageHeaderProps } from "@tarmoto/ui";

/**
 * The console's page header: the shared @tarmoto/ui PageHeader with its
 * condensed sticky bar off by default.
 *
 * That bar exists for the companion, where the page title is the only
 * persistent chrome — once it scrolls away, a condensed copy pins to the top
 * so the title and its actions stay reachable. The console already has a
 * permanent TopBar sitting outside the scroll container, so the bar slides in
 * underneath it and duplicates chrome that never left. Screens import this
 * instead of the shared component so a new one cannot reintroduce it by
 * accident; pass `sticky` explicitly to opt back in.
 */
export function PageHeader({ sticky = false, ...props }: PageHeaderProps) {
  return <UiPageHeader {...props} sticky={sticky} />;
}
