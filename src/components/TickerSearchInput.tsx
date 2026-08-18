import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

type Props = {
  value: string
  options: string[]
  placeholder?: string
  /** When true, show matching options even if the query is empty. */
  showAllWhenOpen?: boolean
  maxSuggestions?: number
  onChange: (value: string) => void
  onPick?: (value: string) => void
}

export function TickerSearchInput({
  value,
  options,
  placeholder = 'e.g. nvda',
  showAllWhenOpen = false,
  maxSuggestions = 8,
  onChange,
  onPick,
}: Props) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const query = value.trim().toLowerCase()
  const suggestions = (
    query
      ? options.filter((label) => label.includes(query) && label !== query)
      : showAllWhenOpen
        ? options
        : []
  ).slice(0, maxSuggestions)

  useEffect(() => {
    setActiveIndex(0)
  }, [query, showAllWhenOpen, options.length])

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  function pick(label: string) {
    onChange(label)
    onPick?.(label)
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        setOpen(true)
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' && suggestions[activeIndex]) {
      event.preventDefault()
      pick(suggestions[activeIndex])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const showList = open && suggestions.length > 0

  return (
    <div className="ticker-search" ref={rootRef}>
      <input
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul id={listId} className="ticker-suggestions" role="listbox">
          {suggestions.map((label, index) => (
            <li key={label} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                className={
                  index === activeIndex
                    ? 'ticker-suggestion active'
                    : 'ticker-suggestion'
                }
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(label)}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
