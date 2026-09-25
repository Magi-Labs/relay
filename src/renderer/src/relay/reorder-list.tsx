import { useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  arrayMove,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
function Item({
  id,
  label,
  horizontal,
  children,
  disabled,
  ignore
}: {
  id: string
  label: string
  horizontal: boolean
  children: ReactNode
  disabled: boolean
  ignore: string
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging, isOver } =
    useSortable({
      id,
      disabled
    })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${label}`}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target instanceof Element && event.target.closest(ignore))
        ) {
          return
        }
        listeners?.onPointerDown?.(event)
      }}
      className={`group flex min-w-0 items-center ${horizontal ? 'h-full shrink-0' : 'w-full'} cursor-grab active:cursor-grabbing ${isDragging ? 'relative z-10 bg-accent opacity-70' : ''} ${isOver && !isDragging ? (horizontal ? 'border-l-2 border-l-ring' : 'border-t-2 border-t-ring') : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition
      }}
    >
      <div className={horizontal ? 'h-full min-w-0' : 'min-w-0 flex-1'}>{children}</div>
    </div>
  )
}
export function ReorderList<T extends { id: string; name: string }>({
  items,
  horizontal = false,
  disabled = false,
  ignore = 'input, [data-no-drag]',
  reorder,
  children
}: {
  items: T[]
  horizontal?: boolean
  disabled?: boolean
  ignore?: string
  reorder: (ids: string[]) => Promise<void>
  children: (item: T) => ReactNode
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id || pending.current) {
            return
          }
          const from = items.findIndex((i) => i.id === active.id),
            to = items.findIndex((i) => i.id === over.id)
          if (from === -1 || to === -1) {
            return
          }
          pending.current = true
          setBusy(true)
          setError('')
          void reorder(arrayMove(items, from, to).map((i) => i.id))
            .catch((e) => setError(String(e)))
            .finally(() => {
              pending.current = false
              setBusy(false)
            })
        }}
      >
        <SortableContext
          items={items.map((i) => i.id)}
          strategy={horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy}
        >
          {items.map((item) => (
            <Item
              key={item.id}
              id={item.id}
              label={item.name}
              horizontal={horizontal}
              disabled={disabled || busy}
              ignore={ignore}
            >
              {children(item)}
            </Item>
          ))}
        </SortableContext>
      </DndContext>
      {error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
