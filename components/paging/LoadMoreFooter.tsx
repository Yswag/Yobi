import { ProgressView, Text, VStack } from "scripting"
import type { VirtualNode } from "scripting"
import { PillButton } from "../../ui/primitives"
import { space, type } from "../../ui/theme"

export function LoadMoreFooter(props: {
  loading: boolean
  hasMore: boolean
  label: string
  endText?: string
  onLoadMore: () => void
}): VirtualNode {
  return (
    <VStack padding={{ vertical: 16, horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
      {props.loading ? (
        <ProgressView />
      ) : props.hasMore ? (
        <PillButton label={props.label} icon="chevron.down" onTap={props.onLoadMore} />
      ) : (
        <Text font={type.meta} foregroundStyle="tertiaryLabel">{props.endText ?? ""}</Text>
      )}
    </VStack>
  )
}
