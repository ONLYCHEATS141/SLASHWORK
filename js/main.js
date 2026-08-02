document.getElementById('year').textContent = new Date().getFullYear();

/* Secuencia del mock de Discord: "escribiendo..." y luego aparece el embed */
const typingIndicator = document.getElementById('typingIndicator');
const botEmbed = document.getElementById('botEmbed');

if (typingIndicator && botEmbed) {
  setTimeout(() => {
    typingIndicator.style.display = 'none';
    botEmbed.style.display = 'block';
  }, 1400);
}

/* Reveal suave al hacer scroll para las tarjetas de servicios y opiniones */
const revealTargets = document.querySelectorAll('.cmd-card, .review-msg, .step');

if ('IntersectionObserver' in window) {
  revealTargets.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(14px)';
    el.style.transition = 'opacity .5s ease, transform .5s ease';
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  revealTargets.forEach(el => observer.observe(el));
}
