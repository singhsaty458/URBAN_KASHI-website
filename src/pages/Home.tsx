import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Pause, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useStore } from '../context/Store';
import { useTitle } from '../lib/api';
import { Empty, ErrorState, Image, Loading, ProductGrid } from '../components/UI';
import { HeroVideo } from '../components/HeroVideo';
import { heroSlides, heroSlideDuration } from '../lib/hero';
import '../premium-home.css';

export const editorialImages = {
  hero: '/images/photo-1617137968427-85924c800a22.jpg',
  detail: '/images/photo-1598033129183-c4f50c736f10.jpg',
  shirts: '/images/photo-1596755094514-f87e34085b2c.jpg',
  tees: '/images/photo-1521572163474-6864f9cf17ab.jpg',
  layers: '/images/photo-1544923246-77307dd654cb.jpg',
  campaign: '/images/photo-1516257984-b1b4d707412e.jpg',
  story: '/images/kashi-riverside.svg',
};

const categories = [
  { name: 'Shirts', image: editorialImages.shirts },
  { name: 'T-Shirts', image: editorialImages.tees },
  { name: 'Trousers', image: '/images/photo-1473966968600-fa801b869a1a.jpg' },
  { name: 'Layers', image: editorialImages.layers },
] as const;

const filters = ['The edit', 'Shirts', 'T-Shirts', 'Layers'] as const;
type EditFilter = typeof filters[number];
const motionPreferenceKey = 'uk-home-motion-paused';

/** Start conservatively; don't animate an element before its visibility is known. */
function useInViewport() {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Without visibility observation, keep photography static and controls usable.
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting && entry.intersectionRatio > 0);
    }, { threshold: [0, 0.05] });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, inView };
}

export function Home() {
  useTitle('Wear your own energy.');
  const { products, productsLoading, productsError, refreshProducts } = useStore();
  const [selection, setSelection] = useState({ active: 0, previous: -1, direction: 'next' });
  const activeSlide = selection.active;
  const swipeStart = useRef<{ id: number; x: number; y: number; time: number } | null>(null);
  const [saveData] = useState(() => typeof navigator !== 'undefined'
    && Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData));
  const [paused, setPaused] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem(motionPreferenceKey) === 'true';
    } catch {
      return false;
    }
  });
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document !== 'undefined' && document.visibilityState === 'visible',
  );
  const [filter, setFilter] = useState<EditFilter>('The edit');
  const filterButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const hero = useInViewport();
  const lookbook = useInViewport();

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(media.matches);
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    updatePreference();
    updateVisibility();
    media.addEventListener('change', updatePreference);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      media.removeEventListener('change', updatePreference);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  // User intent is independent of temporary blockers and OS accessibility settings.
  const motionAllowed = !paused && !reducedMotion && pageVisible;
  const heroRunning = motionAllowed && hero.inView && !hovered && !focusWithin;
  const motionState = reducedMotion ? 'reduced' : paused ? 'paused' : !pageVisible ? 'hidden' : 'running';

  useEffect(() => {
    if (!heroRunning) return;
    // One timer, reset after each selection/resume; no per-frame JS animation work.
    const timer = window.setTimeout(() => {
      setSelection(current => ({ active: (current.active + 1) % heroSlides.length, previous: current.active, direction: 'next' }));
    }, heroSlideDuration);
    return () => window.clearTimeout(timer);
  }, [activeSlide, heroRunning]);

  const activeProducts = products.filter(product => product.active);
  const matchingProducts = activeProducts.filter(product => filter === 'The edit' || product.category === filter);
  // Stable partition: featured first, then the remaining products in catalogue order.
  const featured = [
    ...matchingProducts.filter(product => product.featured),
    ...matchingProducts.filter(product => !product.featured),
  ].slice(0, 4);

  function toggleMotion() {
    const next = !paused;
    setPaused(next);
    try {
      window.localStorage.setItem(motionPreferenceKey, String(next));
    } catch {
      // Restricted storage must not prevent an in-memory motion preference.
    }
  }

  function selectSlide(next: number, direction: 'next' | 'previous') {
    setSelection(current => next === current.active ? current : { active: next, previous: current.active, direction });
  }

  function finishSwipe(event: PointerEvent<HTMLElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.id !== event.pointerId || performance.now() - start.time > 900) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    selectSlide((activeSlide + (dx < 0 ? 1 : -1) + heroSlides.length) % heroSlides.length, dx < 0 ? 'next' : 'previous');
  }

  function handleFilterKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % filters.length; break;
      case 'ArrowLeft': next = (index - 1 + filters.length) % filters.length; break;
      case 'Home': next = 0; break;
      case 'End': next = filters.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setFilter(filters[next]);
    filterButtons.current[next]?.focus();
  }

  return (
    <div
      className="fashion-home"
      data-motion={motionState}
      data-user-paused={paused}
      data-reduced-motion={reducedMotion}
    >
      <section
        ref={hero.ref}
        className="fashion-hero"
        role="region"
        aria-roledescription="carousel"
        aria-label="Fashion editorial"
        data-active-slide={activeSlide + 1}
        data-motion={heroRunning ? 'running' : 'stopped'}
        data-in-view={hero.inView}
        data-hovered={hovered}
        data-focus-within={focusWithin}
        data-direction={selection.direction}
        data-save-data={saveData}
        onPointerEnter={event => { if (event.pointerType !== 'touch') setHovered(true); }}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={event => {
          if (event.pointerType === 'mouse' || !event.isPrimary || (event.target as Element).closest('a, button')) return;
          swipeStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
        }}
        onPointerUp={finishSwipe}
        onPointerCancel={() => { setHovered(false); swipeStart.current = null; }}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
        }}
      >
        <div className="fashion-hero__media" id="fashion-hero-slides" aria-live="off">
          {heroSlides.map((slide, index) => (
            <div
              key={slide.image}
              className={`fashion-hero__slide${index === activeSlide ? ` is-active${selection.previous >= 0 ? ' is-entering' : ''}` : index === selection.previous ? ' is-leaving' : ''}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${heroSlides.length}: ${slide.caption}`}
              aria-hidden={index !== activeSlide}
              data-slide={index + 1}
            >
              <Image
                className="fashion-hero__photo"
                src={slide.image}
                alt={slide.alt}
                fetchPriority={index === 0 ? 'high' : 'low'}
                decoding="async"
              />
              <HeroVideo
                src={slide.video}
                poster={slide.image}
                running={index === activeSlide && heroRunning && !saveData}
              />
            </div>
          ))}
        </div>
        <div className="fashion-hero__content">
          <p className="fashion-kicker">ROOTED IN KASHI. MADE FOR RIGHT NOW.</p>
          <h1>Wear your<br />own <span>energy.</span></h1>
          <div className="fashion-hero__actions">
            <Link to="/shop" className="fashion-button">
              Shop the collection <ArrowUpRight size={19} aria-hidden="true" />
            </Link>
            <a href="#fashion-edit" className="fashion-button fashion-button--outline">
              Explore the edit <ArrowRight size={19} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="fashion-hero__bottom">
          <div className="fashion-hero__notes">
            <p className="fashion-hero__caption" aria-live="off">
              <span className="fashion-hero__index">0{activeSlide + 1} / 03</span>
              {heroSlides[activeSlide].caption}
            </p>
            <p className="fashion-demo-note">Winter editorial · stock footage, not actual store products</p>
          </div>
          <div className="fashion-hero__controls" role="group" aria-label="Editorial carousel controls">
            <button
              type="button"
              className="fashion-motion-toggle"
              aria-pressed={paused}
              aria-describedby="fashion-motion-help"
              onClick={toggleMotion}
            >
              {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
              {paused ? 'Resume motion' : 'Pause motion'}
            </button>
            <div className="fashion-hero__navigation">
              <button
                type="button"
                className="fashion-circle"
                aria-label="Previous slide"
                aria-controls="fashion-hero-slides"
                onClick={() => selectSlide((activeSlide - 1 + heroSlides.length) % heroSlides.length, 'previous')}
              >
                <ArrowLeft size={18} aria-hidden="true" />
              </button>
              <div className="fashion-hero__dots" role="group" aria-label="Choose an editorial slide">
                {heroSlides.map((slide, index) => (
                  <button
                    type="button"
                    key={slide.image}
                    className="fashion-hero__dot"
                    aria-label={`Show slide ${index + 1}: ${slide.caption}`}
                    aria-pressed={index === activeSlide}
                    aria-controls="fashion-hero-slides"
                    onClick={() => selectSlide(index, index < activeSlide ? 'previous' : 'next')}
                  ><span aria-hidden="true" /></button>
                ))}
              </div>
              <button
                type="button"
                className="fashion-circle"
                aria-label="Next slide"
                aria-controls="fashion-hero-slides"
                onClick={() => selectSlide((activeSlide + 1) % heroSlides.length, 'next')}
              >
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
          <p id="fashion-motion-help" className="sr-only">
            Pause controls all looping homepage motion, including muted videos. Swipe left or right to change slides.
            Slides and videos also pause while hovered or focused.
            After resuming, move focus and the pointer outside the hero to allow automatic slides.
            Your device’s reduced-motion preference always takes priority. Manual slide controls remain available.
          </p>
          {reducedMotion && <p className="fashion-motion-note">Reduced motion is on · switch slides manually</p>}
          {saveData && <p className="fashion-motion-note">Data saver is on · showing video posters</p>}
        </div>
      </section>

      <nav className="fashion-strip" aria-label="Explore clothing categories">
        <span>YOUR WARDROBE. YOUR RULES.</span>
        <div>
          {categories.map(category => (
            <Link key={category.name} to={`/shop?category=${category.name}`}>
              {category.name}<ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </nav>

      <section className="fashion-section fashion-categories" id="collections" aria-labelledby="fashion-categories-title">
        <div className="fashion-section__heading">
          <div>
            <p className="fashion-kicker">01 / PICK YOUR DIRECTION</p>
            <h2 id="fashion-categories-title">Make room for you.</h2>
          </div>
          <Link className="fashion-text-link" to="/shop">All clothing <ArrowUpRight size={18} aria-hidden="true" /></Link>
        </div>
        <div className="fashion-category-grid">
          {categories.map((category, index) => {
            const product = activeProducts.find(item => item.category === category.name);
            return (
              <Link className="fashion-category-card" to={`/shop?category=${category.name}`} key={category.name} aria-label={`Shop ${category.name}`}>
                <Image src={product?.image || category.image} alt="" loading="lazy" />
                <span className="fashion-category-card__number" aria-hidden="true">0{index + 1}</span>
                <div className="fashion-category-card__label">
                  <h3>{category.name}</h3>
                  <span className="fashion-category-card__arrow"><ArrowUpRight size={22} aria-hidden="true" /></span>
                </div>
              </Link>
            );
          })}
        </div>
        <p className="fashion-demo-note">Demo catalogue photography · explore each category for available pieces.</p>
      </section>

      <section className="fashion-section featured-section" id="fashion-edit" aria-labelledby="fashion-edit-title">
        <div className="fashion-section__heading">
          <div>
            <p className="fashion-kicker">02 / THE EVERYDAY EDIT</p>
            <h2 id="fashion-edit-title">Your next rotation.</h2>
          </div>
          <Link className="fashion-text-link" to="/shop?sort=newest">See the collection <ArrowUpRight size={18} aria-hidden="true" /></Link>
        </div>
        <div className="fashion-filters" role="tablist" aria-label="Filter the edit">
          {filters.map((name, index) => (
            <button
              type="button"
              key={name}
              ref={node => { filterButtons.current[index] = node; }}
              role="tab"
              id={`fashion-filter-${index}`}
              aria-controls="fashion-edit-panel"
              aria-selected={filter === name}
              tabIndex={filter === name ? 0 : -1}
              onClick={() => setFilter(name)}
              onKeyDown={event => handleFilterKey(event, index)}
            >{name}</button>
          ))}
        </div>
        <div
          id="fashion-edit-panel"
          className="fashion-edit-panel"
          role="tabpanel"
          aria-labelledby={`fashion-filter-${filters.indexOf(filter)}`}
          aria-busy={productsLoading}
          data-filter={filter}
          tabIndex={0}
        >
          {productsLoading ? <Loading /> : productsError ? (
            <ErrorState error={productsError} retry={refreshProducts} />
          ) : featured.length ? (
            <ProductGrid products={featured} />
          ) : (
            <Empty
              title={filter === 'The edit' ? 'The edit is taking shape.' : `No ${filter.toLowerCase()} in the edit yet.`}
              text="There are no matching pieces in the current demo catalogue. Explore the rest of the collection."
              action="Browse all clothing"
            />
          )}
        </div>
      </section>

      <section
        ref={lookbook.ref}
        className="fashion-lookbook"
        aria-labelledby="fashion-lookbook-title"
        data-motion={motionAllowed && lookbook.inView ? 'running' : 'stopped'}
      >
        <div className="fashion-lookbook__photos" aria-hidden="true">
          <div className="fashion-lookbook__frame"><Image src={editorialImages.hero} alt="" loading="lazy" /></div>
          <div className="fashion-lookbook__frame"><Image src={editorialImages.campaign} alt="" loading="lazy" /></div>
        </div>
        <div className="fashion-lookbook__copy">
          <p className="fashion-kicker">03 / A DIFFERENT KIND OF DRESS CODE</p>
          <h2 id="fashion-lookbook-title">Off duty.<br />On your terms.</h2>
          <Link className="fashion-button" to="/shop?category=Layers">Explore layers <ArrowUpRight size={19} aria-hidden="true" /></Link>
          <p className="fashion-demo-note">The off-duty lookbook · demo photography</p>
        </div>
      </section>

      <section className="fashion-heritage" aria-labelledby="fashion-heritage-title">
        <p className="fashion-kicker">VARANASI IN SPIRIT.<br />EVERYWHERE IN STYLE.</p>
        <h2 id="fashion-heritage-title">A little Kashi.<br />A different point of view.</h2>
        <Link className="fashion-text-link" to="/about">Our story <ArrowUpRight size={21} aria-hidden="true" /></Link>
      </section>
    </div>
  );
}