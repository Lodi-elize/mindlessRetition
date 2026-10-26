import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
}

/**
 * 原生 <select> 展开后的列表由操作系统绘制，无法跟随侧边栏主题。
 * 这里用 button + listbox 自绘，交互（方向键、Home/End、Enter、Esc、点击外部关闭）保持完整。
 */
export function ActionSelect({ value, options, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const baseId = useId()
  const menuId = `${baseId}-menu`

  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  const optionId = (index: number) => `${baseId}-option-${index}`

  const openMenu = (index = currentIndex) => {
    setActiveIndex(index)
    setOpen(true)
  }

  const closeMenu = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const choose = (index: number) => {
    const option = options[index]
    if (option && option.value !== value) onChange(option.value)
    closeMenu()
  }

  // 展开前判断向下还是向上：面板底部空间不足时翻到按钮上方，避免被滚动容器裁切
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const boundary = trigger.closest('.mr-main')?.getBoundingClientRect()
    const menuHeight = Math.min(options.length * 32 + 8, 232)
    const spaceBelow = (boundary?.bottom ?? window.innerHeight) - rect.bottom
    const spaceAbove = rect.top - (boundary?.top ?? 0)

    setUp(spaceBelow < menuHeight + 8 && spaceAbove > spaceBelow)
  }, [open, options.length])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) closeMenu(false)
    }
    const handleWindowChange = () => closeMenu(false)

    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('resize', handleWindowChange)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('resize', handleWindowChange)
    }
  }, [open])

  // 键盘移动高亮项时保证它在列表内可见
  useEffect(() => {
    if (!open) return
    menuRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % options.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + options.length) % options.length)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        break
      case 'Tab':
        closeMenu(false)
        break
    }
  }

  return (
    <div className="mr-dd" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        className={`mr-dd-trigger${open ? ' is-open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        onClick={() => {
          if (open) closeMenu()
          else openMenu()
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="mr-dd-value">{options[currentIndex]?.label ?? value}</span>
        <svg className="mr-dd-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.5 6.5 8 10l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul
          ref={menuRef}
          id={menuId}
          className={`mr-dd-menu${up ? ' is-up' : ''}`}
          role="listbox"
          aria-label={ariaLabel}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              className={[
                'mr-dd-option',
                index === activeIndex ? 'is-active' : '',
                option.value === value ? 'is-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="mr-dd-check" aria-hidden="true">
                {option.value === value && (
                  <svg viewBox="0 0 16 16">
                    <path
                      d="m3.5 8.5 3 3 6-7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="mr-dd-label">{option.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
